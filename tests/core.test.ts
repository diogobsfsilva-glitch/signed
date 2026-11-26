import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import * as pkijs from "pkijs";
import {
  findSignatures,
  matchSigner,
  parseCertificate,
  PT_CC_POLICY,
  type TrustStore,
  verifyIncrementalQualifiedSignature,
} from "../supabase/functions/_shared/pades-verify.ts";
import { loadSealKey, sealPdf } from "../supabase/functions/_shared/pades-sign.ts";
import { flattenFields, pageGeom, placeField, readPages, assertValidPdf } from "../supabase/functions/_shared/pdf.ts";
import { buildAuditCertificate } from "../supabase/functions/_shared/audit-cert.ts";
import { PT_INTERMEDIATES, PT_TRUST_ANCHORS } from "../supabase/functions/_shared/trust-pt.ts";
import { trustStoreFromBase64 } from "../supabase/functions/_shared/pades-verify.ts";
import { currentRecipients, fillPhaseDone, validateFieldValues, validateForSend } from "../supabase/functions/_shared/workflow.ts";
import { nameMatches, sha256Hex, fromBase64 } from "../supabase/functions/_shared/util.ts";
import { autoFieldValue, isSignerInput } from "../supabase/functions/_shared/types.ts";
import { cellToValue, mapColumns, parseCsv, toCsv } from "../src/lib/csv.ts";
import { appendIncrementalSignature, testKey, testPem } from "./helpers/incremental.ts";

const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function samplePdf(rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(`Contrato de teste — página ${i + 1}`, { x: 50, y: 780, size: 14, font });
    if (rotate) p.setRotation(degrees(rotate));
  }
  return doc.save({ useObjectStreams: false });
}

function testTrust(): TrustStore {
  return {
    anchors: [parseCertificate(pemToDer(testPem("root")))],
    intermediates: ["cc008", "sigca", "authca", "cc008ec", "sigca_ec"].map((n) => parseCertificate(pemToDer(testPem(n)))),
  };
}
function pemToDer(pem: string) {
  return fromBase64(pem.replace(/-----[^-]+-----/g, ""));
}

describe("geometria", () => {
  it("converte coordenadas relativas para PDF sem rotação", async () => {
    const doc = await PDFDocument.load(await samplePdf());
    const g = pageGeom(doc.getPage(0));
    const p = placeField(g, { x: 0.1, y: 0.1, w: 0.2, h: 0.05 });
    expect(p.rotate).toBe(0);
    expect(p.ox).toBeCloseTo(59.528, 2);
    expect(p.oy).toBeCloseTo(841.89 * 0.85, 2);
    expect(p.bw).toBeCloseTo(119.056, 2);
  });

  it("trata páginas rodadas 90º (dimensões vistas trocadas)", async () => {
    const bytes = await samplePdf(90);
    const info = await readPages(bytes);
    expect(info.pages[0].w).toBeCloseTo(841.89, 1);
    const doc = await PDFDocument.load(bytes);
    const p = placeField(pageGeom(doc.getPage(0)), { x: 0, y: 0, w: 0.1, h: 0.1 });
    // canto inferior-esquerdo da caixa vista = (v=0.1*595, u=0) em PDF
    expect(p.ox).toBeCloseTo(59.528, 2);
    expect(p.oy).toBeCloseTo(0, 2);
    expect(p.rotate).toBe(90);
  });
});

describe("achatar campos", () => {
  it("escreve todos os tipos de campo sem erros, incluindo acentos e emojis", async () => {
    const out = await flattenFields(
      await samplePdf(),
      [
        { id: "1", recipient_id: "r", type: "signature", page: 1, x: 0.1, y: 0.5, w: 0.3, h: 0.08, value: PNG_1x1, options: null, label: null },
        { id: "2", recipient_id: "r", type: "text", page: 1, x: 0.1, y: 0.6, w: 0.3, h: 0.03, value: "João Conceição ✓ 😀", options: null, label: null },
        { id: "3", recipient_id: "r", type: "date", page: 2, x: 0.1, y: 0.6, w: 0.2, h: 0.03, value: "2026-11-21", options: null, label: null },
        { id: "4", recipient_id: "r", type: "checkbox", page: 2, x: 0.1, y: 0.7, w: 0.03, h: 0.02, value: "true", options: null, label: null },
        { id: "5", recipient_id: "r", type: "radio", page: 2, x: 0.5, y: 0.7, w: 0.3, h: 0.06, value: "Sim", options: ["Sim", "Não"], label: null },
        { id: "6", recipient_id: "r", type: "dropdown", page: 2, x: 0.5, y: 0.8, w: 0.3, h: 0.03, value: "Lisboa", options: ["Lisboa", "Porto"], label: null },
      ],
      { mode: "simple" },
    );
    expect(await assertValidPdf(out)).toBe(2);
  });

  it("modo CC: desenha marcadores de assinatura com o nome", async () => {
    const out = await flattenFields(
      await samplePdf(90),
      [{ id: "1", recipient_id: "r1", type: "signature", page: 1, x: 0.5, y: 0.8, w: 0.35, h: 0.08, value: null, options: null, label: null }],
      { mode: "qualified", qualifiedPlaceholders: true, recipients: [{ id: "r1", name: "Maria Fernandes Silva" }] },
    );
    expect(await assertValidPdf(out)).toBe(2);
  });

  it("recusa ficheiros que não são PDF", async () => {
    await expect(assertValidPdf(new TextEncoder().encode("olá"))).rejects.toThrow("não é um PDF");
  });
});

describe("selo da plataforma", () => {
  it("assina o PDF e a assinatura é válida e cobre o ficheiro todo", async () => {
    const key = await loadSealKey(testPem("seal"), (await import("node:fs")).readFileSync(new URL("./fixtures/pki/seal.p8", import.meta.url), "utf8"));
    const sealed = await sealPdf(await samplePdf(), key, { reason: "Teste", name: "Signed" });
    const sigs = findSignatures(sealed);
    expect(sigs).toHaveLength(1);
    const [, , c, d] = sigs[0].byteRange;
    expect(c + d).toBe(sealed.length);
    expect(sigs[0].subFilter).toBe("ETSI.CAdES.detached");
    // Verifica com pkijs
    const asn = (await import("asn1js")).fromBER(sigs[0].contents.slice().buffer);
    const sd = new pkijs.SignedData({ schema: new pkijs.ContentInfo({ schema: asn.result }).content });
    const [, b] = sigs[0].byteRange;
    const data = new Uint8Array([...sealed.subarray(0, b), ...sealed.subarray(c)]);
    const res = await sd.verify({ signer: 0, data: data.buffer, extendedMode: true });
    expect(res.signatureVerified).toBe(true);
  });
});

describe("validação de assinatura com Cartão de Cidadão", () => {
  const trust = testTrust();

  it("aceita uma assinatura qualificada válida e extrai os dados do titular", async () => {
    const prepared = await samplePdf();
    const signed = await appendIncrementalSignature(prepared, await testKey("maria", ["sigca", "cc008"]));
    const r = await verifyIncrementalQualifiedSignature(prepared, signed, { trust });
    expect(r.signer.commonName).toBe("Maria Fernandes Silva");
    expect(r.signer.serialNumberAttr).toBe("BI123456780");
    expect(r.signer.issuerCommonName).toMatch(PT_CC_POLICY.signerIssuerCn);
    expect(r.chain.map((c) => c.commonName)).toContain("Cartão de Cidadão 008");
    expect(r.newSha256).toBe(await sha256Hex(signed));
  });

  it("aceita assinaturas sucessivas (2.º signatário sobre o PDF já assinado)", async () => {
    const prepared = await samplePdf();
    const s1 = await appendIncrementalSignature(prepared, await testKey("maria", ["sigca", "cc008"]));
    const s2 = await appendIncrementalSignature(s1, await testKey("joao", ["sigca", "cc008"]));
    const r = await verifyIncrementalQualifiedSignature(s1, s2, { trust });
    expect(r.signer.commonName).toBe("João Pedro Costa");
    expect(findSignatures(s2)).toHaveLength(2);
  });

  it("aceita cadeia não incluída na assinatura (usa as CAs conhecidas)", async () => {
    const prepared = await samplePdf();
    const signed = await appendIncrementalSignature(prepared, await testKey("maria"));
    await expect(verifyIncrementalQualifiedSignature(prepared, signed, { trust })).resolves.toBeTruthy();
  });

  it("aceita a hierarquia EC atual (CA intermédia P-521, como a «Cartão de Cidadão 008»)", async () => {
    const prepared = await samplePdf();
    const signed = await appendIncrementalSignature(prepared, await testKey("ana_ec", ["sigca_ec", "cc008ec"]));
    const r = await verifyIncrementalQualifiedSignature(prepared, signed, { trust });
    expect(r.signer.commonName).toBe("Ana Ribeiro");
    expect(r.chain.map((c) => c.commonName)).toContain("Cartão de Cidadão 008");
  });

  it("deteta assinatura P-521 adulterada (verificação em JavaScript puro)", async () => {
    const sub = parseCertificate(pemToDer(testPem("sigca_ec")));
    const issuer = parseCertificate(pemToDer(testPem("cc008ec")));
    expect(await sub.verify(issuer)).toBe(true);
    const bad = parseCertificate(pemToDer(testPem("sigca_ec")));
    const v = new Uint8Array(bad.signatureValue.valueBlock.valueHexView);
    v[v.length - 3] ^= 0xff;
    bad.signatureValue = new (await import("asn1js")).BitString({ valueHex: v.buffer });
    expect(await bad.verify(issuer)).toBe(false);
  });

  it("recusa um cartão falso (cadeia com outra raiz, mesmos nomes)", async () => {
    const prepared = await samplePdf();
    const signed = await appendIncrementalSignature(prepared, await testKey("rogue", ["rogue_sigca", "rogue_cc", "rogue_root"]));
    await expect(verifyIncrementalQualifiedSignature(prepared, signed, { trust })).rejects.toMatchObject({ code: "untrusted" });
  });

  it("recusa certificado falso com as CAs verdadeiras acrescentadas na assinatura", async () => {
    // O atacante assina com um certificado próprio cujo emissor tem o nome da CA verdadeira e
    // inclui na assinatura as CAs verdadeiras, na esperança de que sejam essas a ser validadas.
    // Caso perigoso: a CA verdadeira acrescentada não está na lista local (ex.: CMD 00003/00004).
    const partialTrust: TrustStore = { anchors: trust.anchors, intermediates: [parseCertificate(pemToDer(testPem("cc008")))] };
    const prepared = await samplePdf();
    const signed = await appendIncrementalSignature(prepared, await testKey("rogue", ["sigca", "cc008"]));
    await expect(verifyIncrementalQualifiedSignature(prepared, signed, { trust: partialTrust })).rejects.toMatchObject({ code: "untrusted" });
    // E a assinatura legítima com a mesma lista parcial continua a ser aceite (a CA vem na assinatura).
    const ok = await appendIncrementalSignature(prepared, await testKey("maria", ["sigca", "cc008"]));
    await expect(verifyIncrementalQualifiedSignature(prepared, ok, { trust: partialTrust })).resolves.toBeTruthy();
  });

  it("recusa o certificado de autenticação do cartão", async () => {
    const prepared = await samplePdf();
    const signed = await appendIncrementalSignature(prepared, await testKey("maria_auth", ["authca", "cc008"]));
    await expect(verifyIncrementalQualifiedSignature(prepared, signed, { trust })).rejects.toMatchObject({ code: "not_signature_cert" });
  });

  it("recusa um PDF que não começa pelos bytes do documento enviado", async () => {
    const prepared = await samplePdf();
    const other = await samplePdf(90);
    const signed = await appendIncrementalSignature(other, await testKey("maria", ["sigca", "cc008"]));
    await expect(verifyIncrementalQualifiedSignature(prepared, signed, { trust })).rejects.toMatchObject({ code: "not_incremental" });
  });

  it("recusa conteúdo alterado depois de assinar", async () => {
    const prepared = await samplePdf();
    const signed = await appendIncrementalSignature(prepared, await testKey("maria", ["sigca", "cc008"]));
    const tampered = new Uint8Array([...signed, ...new TextEncoder().encode("\n1 0 obj << /Evil true >> endobj\n")]);
    await expect(verifyIncrementalQualifiedSignature(prepared, tampered, { trust })).rejects.toMatchObject({ code: "trailing_data" });
  });

  it("recusa bytes alterados dentro da zona assinada", async () => {
    const prepared = await samplePdf();
    const signed = await appendIncrementalSignature(prepared, await testKey("maria", ["sigca", "cc008"]));
    const tampered = signed.slice();
    // altera um byte da parte nova (zona assinada), fora do Contents
    const idx = tampered.length - 20;
    tampered[idx] = tampered[idx] === 0x30 ? 0x31 : 0x30;
    await expect(verifyIncrementalQualifiedSignature(prepared, tampered, { trust })).rejects.toBeTruthy();
  });

  it("recusa upload sem assinatura nova", async () => {
    const prepared = await samplePdf();
    const same = new Uint8Array([...prepared, 0x0a]);
    await expect(verifyIncrementalQualifiedSignature(prepared, same, { trust })).rejects.toMatchObject({ code: "no_signature" });
  });

  it("valida o titular por nº de identificação civil ou nome", () => {
    const cert = { commonName: "Maria Fernandes Silva", givenName: "Maria", surname: "Fernandes Silva", serialNumberAttr: "BI123456780" } as never;
    expect(matchSigner(cert, { name: "Maria Silva", civil_id: null }, nameMatches).ok).toBe(true);
    expect(matchSigner(cert, { name: "Ana Silva", civil_id: null }, nameMatches).ok).toBe(false);
    expect(matchSigner(cert, { name: "Outra", civil_id: "12345678" }, nameMatches).ok).toBe(true);
    expect(matchSigner(cert, { name: "Maria Silva", civil_id: "99999999" }, nameMatches).ok).toBe(false);
  });

  it("carrega os certificados reais do Estado português", () => {
    const real = trustStoreFromBase64(PT_TRUST_ANCHORS, PT_INTERMEDIATES);
    expect(real.anchors.length).toBe(2);
    const cns = real.intermediates.map((c) => c.subject.typesAndValues.find((t) => t.type === "2.5.4.3")!.value.valueBlock.value);
    expect(cns).toContain("EC de Assinatura Digital Qualificada do Cartão de Cidadão 0020");
    expect(cns).toContain("EC de Chave Móvel Digital de Assinatura Digital Qualificada do Cartão de Cidadão 00007");
    expect(cns.filter((n: string) => PT_CC_POLICY.requiredIntermediateCn.test(n)).length).toBe(6);
    // Todas as CAs de assinatura (CC e CMD) passam no filtro do emissor
    for (const n of cns.filter((n: string) => n.startsWith("EC de"))) expect(n).toMatch(PT_CC_POLICY.signerIssuerCn);
  });

  it("as CAs reais encadeiam até à ECRaizEstado (incluindo a CMD 00007 via CC 008 P-521)", async () => {
    const real = trustStoreFromBase64(PT_TRUST_ANCHORS, PT_INTERMEDIATES);
    const cnOf = (c: pkijs.Certificate) => c.subject.typesAndValues.find((t) => t.type === "2.5.4.3")!.value.valueBlock.value as string;
    const wanted = [/Cidadão 00007$/, /Cidadão 00001$/, /Qualificada do Cartão de Cidadão 0020$/];
    for (const ca of real.intermediates.filter((c) => wanted.some((w) => w.test(cnOf(c))))) {
      const engine = new pkijs.CertificateChainValidationEngine({
        trustedCerts: real.anchors,
        certs: [...real.intermediates.filter((c) => c !== ca), ca],
        checkDate: new Date("2026-06-01"),
      });
      const r = await engine.verify();
      const cn = ca.subject.typesAndValues.find((t) => t.type === "2.5.4.3")!.value.valueBlock.value;
      expect(r.result, `${cn}: ${r.resultMessage}`).toBe(true);
      expect(cnOf(r.certificatePath![0])).toBe(cn);
      expect(r.certificatePath!.map(cnOf)).toContain(cn.endsWith("00001") ? "Cartão de Cidadão 004" : "Cartão de Cidadão 008");
    }
  }, 120_000);

  it("um certificado de teste não passa na cadeia real", async () => {
    const real = trustStoreFromBase64(PT_TRUST_ANCHORS, PT_INTERMEDIATES);
    const prepared = await samplePdf();
    const signed = await appendIncrementalSignature(prepared, await testKey("maria", ["sigca", "cc008"]));
    await expect(verifyIncrementalQualifiedSignature(prepared, signed, { trust: real })).rejects.toMatchObject({ code: "untrusted" });
  });
});

describe("fluxo", () => {
  const recips = [
    { id: "a", role: "signer" as const, signing_order: 1, status: "notified" as const },
    { id: "b", role: "signer" as const, signing_order: 2, status: "pending" as const },
    { id: "c", role: "cc" as const, signing_order: 1, status: "pending" as const },
  ];
  it("sequencial: só o primeiro", () => {
    const cur = currentRecipients({ signature_mode: "simple", phase: "fill", sequential: true }, recips, []);
    expect(cur.map((r) => r.id)).toEqual(["a"]);
  });
  it("paralelo: todos os signatários", () => {
    const cur = currentRecipients({ signature_mode: "simple", phase: "fill", sequential: false }, recips, []);
    expect(cur.map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("modo CC: fase de preenchimento só inclui quem tem campos a preencher", () => {
    const fields = [
      { recipient_id: "b", type: "text" as const },
      { recipient_id: "a", type: "signature" as const },
    ];
    const doc = { signature_mode: "qualified" as const, phase: "fill" as const, sequential: true };
    expect(currentRecipients(doc, recips, fields).map((r) => r.id)).toEqual(["b"]);
    expect(fillPhaseDone(doc, recips, fields)).toBe(false);
    expect(fillPhaseDone(doc, recips.map((r) => (r.id === "b" ? { ...r, status: "filled" as const } : r)), fields)).toBe(true);
  });
  it("modo CC: assinatura é sempre um de cada vez", () => {
    const doc = { signature_mode: "qualified" as const, phase: "sign" as const, sequential: false };
    expect(currentRecipients(doc, recips, [])).toHaveLength(1);
  });
  it("valida antes de enviar", () => {
    const issues = validateForSend(
      { signature_mode: "qualified", phase: "fill", sequential: true, original_path: "x" },
      [{ id: "a", role: "signer", signing_order: 1, status: "pending", name: "Ana", email: "a@x.pt" }],
      [{ id: "f", recipient_id: "a", type: "initials", options: null }],
    );
    expect(issues.map((i) => i.message).join(" ")).toContain("não tem nenhum campo de assinatura");
    expect(issues.map((i) => i.message).join(" ")).toContain("iniciais");
  });
  it("valida valores submetidos", () => {
    const fields = [
      { id: "1", type: "text" as const, required: true, options: null, label: "Nome" },
      { id: "2", type: "dropdown" as const, required: false, options: ["A", "B"], label: "Hotel" },
      { id: "3", type: "signature" as const, required: true, options: null, label: null },
    ];
    expect(validateFieldValues(fields, { "1": "", "2": "C", "3": "x" })).toHaveLength(3);
    expect(validateFieldValues(fields, { "1": "Ana", "2": "A", "3": PNG_1x1 })).toHaveLength(0);
  });
});

describe("certificado de conclusão", () => {
  it("gera um PDF com várias páginas quando o histórico é longo", async () => {
    const events = Array.from({ length: 120 }, (_, i) => ({
      event: i % 2 ? "recipient.viewed" : "recipient.notified",
      created_at: new Date(2026, 10, 21, 10, i).toISOString(),
      recipient_id: "r1",
      ip: "10.0.0.1",
      hash: "a".repeat(64),
    }));
    const bytes = await buildAuditCertificate({
      orgName: "Altis Hotels",
      document: {
        id: "d1",
        title: "Contrato de fornecimento — Hotel Altis Avenida",
        signature_mode: "qualified",
        sent_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        original_sha256: "b".repeat(64),
        final_sha256: "c".repeat(64),
        final_label: "do PDF assinado",
      },
      owner: { name: "Diogo", email: "diogo@altishotels.com" },
      recipients: [
        {
          id: "r1", name: "Maria Fernandes Silva", email: "maria@x.pt", role: "signer", signing_order: 1, status: "signed",
          signed_at: new Date().toISOString(), sign_ip: "10.0.0.1", cert_subject: "CN=Maria Fernandes Silva",
          cert_issuer: "CN=EC de Assinatura Digital Qualificada do Cartão de Cidadão 0020", cert_serial: "0a1b", decline_reason: null,
        },
      ],
      events,
      chainIntact: true,
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

describe("grupo 1: campos automáticos, fixos e anexos", () => {
  it("escreve nome, email, data de assinatura e referência ao anexo no PDF", async () => {
    const out = await flattenFields(
      await samplePdf(),
      [
        { id: "1", recipient_id: "r", type: "name", page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.03, value: "Joana Conceição", options: null, label: null },
        { id: "2", recipient_id: "r", type: "email", page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.03, value: "joana@exemplo.pt", options: null, label: null },
        { id: "3", recipient_id: "r", type: "signed_date", page: 1, x: 0.1, y: 0.3, w: 0.2, h: 0.03, value: "2026-11-22", options: null, label: null },
        { id: "4", recipient_id: "r", type: "attachment", page: 1, x: 0.1, y: 0.4, w: 0.3, h: 0.03, value: JSON.stringify({ path: "a/b/attachments/x", name: "CC.pdf", size: 1, type: "application/pdf", sha256: "0" }), options: null, label: null },
      ],
      { mode: "simple" },
    );
    expect(await assertValidPdf(out)).toBe(2);
  });

  it("campos automáticos: valores e regras", () => {
    const r = { name: "Joana Reis", email: "joana@exemplo.pt" };
    expect(autoFieldValue("name", r)).toBe("Joana Reis");
    expect(autoFieldValue("email", r)).toBe("joana@exemplo.pt");
    // Inverno: Lisboa = UTC, ainda é 31/12.
    expect(autoFieldValue("signed_date", r, new Date("2026-12-31T23:30:00Z"))).toBe("2026-12-31");
    // Verão: Lisboa = UTC+1, já é 1/8.
    expect(autoFieldValue("signed_date", r, new Date("2026-07-31T23:30:00Z"))).toBe("2026-08-01");
    expect(isSignerInput({ type: "name" }, "simple")).toBe(false);
    expect(isSignerInput({ type: "text", readonly: true }, "simple")).toBe(false);
    expect(isSignerInput({ type: "attachment" }, "qualified")).toBe(true);
    expect(isSignerInput({ type: "signature" }, "qualified")).toBe(false);
  });

  it("validação antes de enviar: fixo sem valor, pré-preenchido inválido e email em falta", () => {
    const issues = validateForSend(
      { signature_mode: "simple", phase: "fill", sequential: true, original_path: "x" },
      [{ id: "a", role: "signer", signing_order: 1, status: "pending", name: "Ana", email: "" }],
      [
        { id: "s", recipient_id: "a", type: "signature", options: null },
        { id: "t", recipient_id: "a", type: "text", options: null, readonly: true, value: null, label: "Hotel" },
        { id: "d", recipient_id: "a", type: "dropdown", options: ["A", "B"], value: "C", label: "Lista" },
      ],
    ).map((i) => i.message).join(" | ");
    expect(issues).toContain('fixo "Hotel" não tem valor');
    expect(issues).toContain("Valor pré-preenchido inválido");
    expect(issues).toContain("Falta o email de Ana");
  });

  it("valores submetidos: anexos só com caminho válido e automáticos recusados", () => {
    const f = [{ id: "1", type: "attachment" as const, required: true, options: null, label: "CC" }];
    expect(validateFieldValues(f, { "1": "../../etc/passwd" })).toHaveLength(1);
    expect(validateFieldValues(f, { "1": `${"a".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/${"b".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/attachments/r-f-1-cc.pdf` })).toHaveLength(0);
    expect(validateFieldValues([{ id: "2", type: "name" as const, required: false, options: null, label: null }], { "2": "Outro" })).toHaveLength(1);
  });
});

describe("envio em massa: CSV", () => {
  it("lê CSV do Excel português (;, BOM, aspas, CRLF, linhas vazias)", () => {
    const rows = parseCsv('\uFEFFNome;Email;Morada\r\n"Silva; João";joao@x.pt;"Rua ""A"", 1"\r\n\r\nAna;ana@x.pt;\r\n');
    expect(rows).toEqual([["Nome", "Email", "Morada"], ["Silva; João", "joao@x.pt", 'Rua "A", 1'], ["Ana", "ana@x.pt", ""]]);
    expect(parseCsv("nome,email\nRui,rui@x.pt")).toEqual([["nome", "email"], ["Rui", "rui@x.pt"]]);
    expect(parseCsv(toCsv([["a;b", 'c"d'], ["1", "2"]]))).toEqual([["a;b", 'c"d'], ["1", "2"]]);
  });

  it("identifica colunas pelo nome, sem acentos nem maiúsculas", () => {
    const c = mapColumns(["Nome completo", "E-mail", "Nº Identificação Civil", "Vencimento", "Hotel ", "Outra"], ["vencimento", "Hotel"]);
    expect(c.name).toBe(0);
    expect(c.email).toBe(1);
    expect(c.civilId).toBe(2); // "Nº Identificação Civil" -> "n identificacao civil"
    expect([...c.fields.values()]).toEqual(["vencimento", "hotel"]);
    expect(c.unknown).toContain("Outra");
  });

  it("converte células em valores dos campos", () => {
    expect(cellToValue("date", "5/3/2027", null)).toEqual({ value: "2027-03-05" });
    expect(cellToValue("date", "2027-03-05", null)).toEqual({ value: "2027-03-05" });
    expect(cellToValue("date", "amanhã", null).error).toBeTruthy();
    expect(cellToValue("checkbox", "Não", null)).toEqual({ value: "false" });
    expect(cellToValue("dropdown", "porto", ["Lisboa", "Porto"])).toEqual({ value: "Porto" });
    expect(cellToValue("dropdown", "Faro", ["Lisboa", "Porto"]).error).toContain("não é uma das opções");
    expect(cellToValue("text", "  ", null)).toEqual({ value: null });
  });
});

describe("idiomas", () => {
  it("reconhece o idioma no CSV", async () => {
    const { parseLanguage } = await import("../src/lib/csv.ts");
    expect(["EN", "Inglês", "english", "Español", "francês", "PT", "xx"].map(parseLanguage)).toEqual(["en", "en", "en", "es", "fr", "pt", null]);
  });

  it("emails ao signatário traduzidos e com a marca do hotel", async () => {
    const { inviteEmail, otpEmail, completedEmail } = await import("../supabase/functions/_shared/email.ts");
    const brand = { name: "Altis Grand Hotel", color: "#7a1f2b", logoUrl: "https://exemplo.pt/logo.png" };
    const en = inviteEmail({ recipientName: "John", senderName: "Diogo", title: "Spa waiver", message: null, url: "https://x/s/abc", mode: "simple", step: "sign", expiresAt: null, lang: "en", brand });
    expect(en.subject).toBe("Diogo asks you to sign: Spa waiver");
    expect(en.html).toContain('lang="en"');
    expect(en.html).toContain("#7a1f2b");
    expect(en.html).toContain("logo.png");
    // O código nunca vai no assunto (fica no registo de emails); vai no corpo.
    const otp = otpEmail("Juan", "Contrato", "123456", { lang: "es" });
    expect(otp.subject).toBe("Código de acceso de Signed: Contrato");
    expect(otp.subject).not.toContain("123456");
    expect(otp.html).toContain("123456");
    expect(completedEmail("Marie", "Contrat", "simple", [], { lang: "fr" }).subject).toBe("Terminé : Contrat");
    // Sem idioma: português e sem marca.
    const pt = inviteEmail({ recipientName: "Ana", senderName: "Diogo", title: "X", message: null, url: "u", mode: "simple", step: "sign", expiresAt: null });
    expect(pt.subject).toBe("Diogo pede-lhe para assinar: X");
    expect(pt.html).toContain(">Signed<");
  });

  it("dicionários completos nas 4 línguas", async () => {
    const { DICTS } = await import("../src/lib/signer-i18n.ts");
    const keys = Object.keys(DICTS.pt).sort();
    for (const l of ["en", "es", "fr"] as const) expect(Object.keys(DICTS[l]).sort()).toEqual(keys);
  });
});

describe("pacotes de documentos", () => {
  it("calcula as páginas de cada documento e valida a lista", async () => {
    const { partRanges, partsProblem } = await import("../supabase/functions/_shared/types.ts");
    const parts = [{ name: "Contrato", pages: 3 }, { name: "Anexo I", pages: 1 }, { name: "RGPD", pages: 2 }];
    expect(partRanges(parts)).toEqual([
      { name: "Contrato", from: 1, to: 3 },
      { name: "Anexo I", from: 4, to: 4 },
      { name: "RGPD", from: 5, to: 6 },
    ]);
    expect(partsProblem(parts, 6)).toBeNull();
    expect(partsProblem(null, 6)).toBeNull();
    expect(partsProblem(parts, 7)).toMatch(/não corresponde/);
    expect(partsProblem([{ name: " ", pages: 1 }], 1)).toMatch(/nome/);
    expect(partsProblem([{ name: "A", pages: 0 }], 0)).toMatch(/sem páginas/);
    const base = { signature_mode: "simple" as const, phase: "fill" as const, sequential: true, original_path: "x" };
    const rec = [{ id: "r", role: "signer" as const, signing_order: 1, status: "pending" as const, name: "Ana", email: "ana@x.pt" }];
    const fld = [{ id: "f", recipient_id: "r", type: "signature" as const, options: null, page: 1 }];
    expect(validateForSend({ ...base, parts, page_count: 5 }, rec, fld).map((i) => i.message).join()).toMatch(/pacote não corresponde/);
    expect(validateForSend({ ...base, parts, page_count: 6 }, rec, fld)).toEqual([]);
  });

  it("separa um documento do pacote sem perder a rotação", async () => {
    const { extractPages } = await import("../supabase/functions/_shared/pdf.ts");
    const doc = await PDFDocument.create();
    for (let i = 0; i < 5; i++) {
      const p = doc.addPage([400 + i * 10, 600]);
      if (i === 3) p.setRotation(degrees(90));
    }
    const part = await PDFDocument.load(await extractPages(await doc.save(), 3, 4));
    expect(part.getPageCount()).toBe(2);
    expect(part.getPage(0).getWidth()).toBe(420);
    expect(part.getPage(1).getRotation().angle).toBe(90);
  });

  it("o certificado lista os documentos do pacote", async () => {
    const bytes = await buildAuditCertificate({
      orgName: "Altis Hotels",
      document: { id: "d1", title: "Admissão", signature_mode: "simple", sent_at: null, completed_at: null, original_sha256: null, final_sha256: null, final_label: "do pacote completo" },
      owner: { name: "Diogo", email: "d@altishotels.com" },
      recipients: [],
      events: [],
      chainIntact: true,
      parts: [{ name: "Contrato", from: 1, to: 3, sha256: "a".repeat(64) }, { name: "RGPD", from: 4, to: 4, sha256: null }],
      partsSigned: true,
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
  });
});

describe("lote A/B: validações", () => {
  it("datas que não existem são recusadas", async () => {
    const { isValidIsoDate } = await import("../supabase/functions/_shared/workflow.ts");
    expect(isValidIsoDate("2026-02-28")).toBe(true);
    expect(isValidIsoDate("2028-02-29")).toBe(true);
    expect(isValidIsoDate("2026-02-31")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(cellToValue("date", "31/02/2027", null).error).toMatch(/inválida/);
    expect(cellToValue("date", "28/02/2027", null).value).toBe("2027-02-28");
    const f = [{ id: "d", type: "date" as const, required: true, options: null, label: "Nascimento" }];
    expect(validateFieldValues(f, { d: "2026-02-31" })[0]).toMatch(/Data inválida/);
    // Valores que não são texto (ex.: objetos enviados à mão) são recusados.
    const t = [{ id: "t", type: "text" as const, required: true, options: null, label: "Cargo" }];
    expect(validateFieldValues(t, { t: { a: 1 } as unknown as string })[0]).toMatch(/inválido/);
  });

  it("a assinatura tem de ser um PNG verdadeiro e de tamanho razoável", async () => {
    const { assertSignaturePng } = await import("../supabase/functions/_shared/pdf.ts");
    await expect(assertSignaturePng(PNG_1x1)).resolves.toBeUndefined();
    await expect(assertSignaturePng("data:image/png;base64,AAAA")).rejects.toThrow();
    // Cabeçalho PNG válido mas largura gigante.
    const bytes = fromBase64(PNG_1x1.split(",")[1]);
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(16, 50_000);
    const big = "data:image/png;base64," + Buffer.from(bytes).toString("base64");
    await expect(assertSignaturePng(big)).rejects.toThrow(/bad_size/);
  });

  it("o CSV exportado neutraliza fórmulas do Excel", () => {
    const out = toCsv([["Nome"], ["=HYPERLINK(\"x\")"], ["+351 912"], ["Ana"]]);
    expect(out).toContain(`"'=HYPERLINK(""x"")"`);
    expect(out).toContain("'+351 912");
    expect(out).toContain("\r\nAna\r\n");
  });
});
