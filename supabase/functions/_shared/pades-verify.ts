// Validação de assinaturas PAdES feitas com Cartão de Cidadão / Chave Móvel Digital
// (ex.: na app Autenticação.gov) sobre um PDF preparado pelo Signed.

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { bytesEqual, concatBytes, fromBase64, fromHex, sha256Hex, toArrayBuffer, toHex } from "./util.ts";
import { installCryptoEngine } from "./crypto-engine.ts";

installCryptoEngine();

export interface PdfSignature {
  byteRange: [number, number, number, number];
  subFilter: string | null;
  contents: Uint8Array;
  isDocTimestamp: boolean;
}

const BYTE_RANGE = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;

function latin1(bytes: Uint8Array): string {
  // Um carácter por byte: os índices da string coincidem com os offsets do ficheiro.
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return s;
}

/** Localiza as assinaturas de um PDF a partir dos /ByteRange. */
export function findSignatures(pdf: Uint8Array): PdfSignature[] {
  const text = latin1(pdf);
  const out: PdfSignature[] = [];
  for (const m of text.matchAll(BYTE_RANGE)) {
    const br = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
    const [a, b, c, d] = br;
    if (a !== 0 || b <= 0 || c <= b || c + d > pdf.length) continue;
    if (text[b] !== "<" || text[c - 1] !== ">") continue;
    // Dicionário da assinatura: do "obj" anterior ao "endobj" seguinte.
    const objStart = text.lastIndexOf(" obj", Math.min(m.index!, b));
    const objEnd = text.indexOf("endobj", c);
    const dict = text.slice(Math.max(0, objStart), b) + text.slice(c, objEnd > 0 ? objEnd : c + 4000);
    const sf = /\/SubFilter\s*\/([A-Za-z0-9.#_-]+)/.exec(dict)?.[1] ?? null;
    const type = /\/Type\s*\/([A-Za-z]+)/.exec(dict)?.[1] ?? null;
    out.push({
      byteRange: br,
      subFilter: sf,
      contents: fromHex(text.slice(b + 1, c - 1)),
      isDocTimestamp: sf === "ETSI.RFC3161" || type === "DocTimeStamp",
    });
  }
  // Remove duplicados (o mesmo ByteRange pode aparecer em versões repetidas do objeto).
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = s.byteRange.join(",");
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

export interface CertInfo {
  subject: string;
  commonName: string;
  givenName: string | null;
  surname: string | null;
  serialNumberAttr: string | null;
  issuer: string;
  issuerCommonName: string;
  serial: string;
  notBefore: string;
  notAfter: string;
}

const OID_NAMES: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.4": "SN",
  "2.5.4.5": "serialNumber",
  "2.5.4.6": "C",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.42": "GN",
};

function rdnGet(name: pkijs.RelativeDistinguishedNames, oid: string): string | null {
  const tv = name.typesAndValues.find((t) => t.type === oid);
  return tv ? String(tv.value.valueBlock.value) : null;
}

function rdnString(name: pkijs.RelativeDistinguishedNames): string {
  return name.typesAndValues.map((t) => `${OID_NAMES[t.type] ?? t.type}=${t.value.valueBlock.value}`).join(", ");
}

export function certInfo(cert: pkijs.Certificate): CertInfo {
  return {
    subject: rdnString(cert.subject),
    commonName: rdnGet(cert.subject, "2.5.4.3") ?? "",
    givenName: rdnGet(cert.subject, "2.5.4.42"),
    surname: rdnGet(cert.subject, "2.5.4.4"),
    serialNumberAttr: rdnGet(cert.subject, "2.5.4.5"),
    issuer: rdnString(cert.issuer),
    issuerCommonName: rdnGet(cert.issuer, "2.5.4.3") ?? "",
    serial: toHex(cert.serialNumber.valueBlock.valueHexView),
    notBefore: cert.notBefore.value.toISOString(),
    notAfter: cert.notAfter.value.toISOString(),
  };
}

export function parseCertificate(der: Uint8Array): pkijs.Certificate {
  const asn = asn1js.fromBER(toArrayBuffer(der));
  if (asn.offset === -1) throw new Error("Certificado inválido");
  return new pkijs.Certificate({ schema: asn.result });
}

export interface TrustStore {
  anchors: pkijs.Certificate[];
  intermediates: pkijs.Certificate[];
}

export function trustStoreFromBase64(anchors: Record<string, string>, intermediates: Record<string, string>): TrustStore {
  return {
    anchors: Object.values(anchors).map((b) => parseCertificate(fromBase64(b))),
    intermediates: Object.values(intermediates).map((b) => parseCertificate(fromBase64(b))),
  };
}

/** Regras sobre a cadeia: emissor do certificado de assinatura e CA intermédia do Cartão de Cidadão. */
export interface QualifiedPolicy {
  signerIssuerCn: RegExp;
  requiredIntermediateCn: RegExp;
}

export const PT_CC_POLICY: QualifiedPolicy = {
  // CC: "EC de Assinatura Digital Qualificada do Cartão de Cidadão 00NN"
  // CMD: "EC de Chave Móvel Digital de Assinatura Digital Qualificada do Cartão de Cidadão 000N"
  signerIssuerCn: /Assinatura Digital Qualificada do Cart[aã]o de Cidad[aã]o/i,
  requiredIntermediateCn: /^Cart[aã]o de Cidad[aã]o \d+$/i,
};

function parseSignedData(der: Uint8Array): pkijs.SignedData {
  const asn = asn1js.fromBER(toArrayBuffer(der));
  if (asn.offset === -1) throw new VerifyError("A assinatura do PDF está corrompida.");
  const ci = new pkijs.ContentInfo({ schema: asn.result });
  if (ci.contentType !== pkijs.ContentInfo.SIGNED_DATA) throw new VerifyError("Formato de assinatura não suportado.");
  return new pkijs.SignedData({ schema: ci.content });
}

function signedAttr(sd: pkijs.SignedData, oid: string): asn1js.AsnType | null {
  const attr = sd.signerInfos[0]?.signedAttrs?.attributes.find((a) => a.type === oid);
  return attr ? (attr.values[0] as asn1js.AsnType) : null;
}

export class VerifyError extends Error {
  code: string;
  constructor(message: string, code = "invalid") {
    super(message);
    this.code = code;
  }
}

/** Verifica criptograficamente uma assinatura CMS destacada sobre os bytes indicados. */
async function verifyCms(sig: PdfSignature, pdf: Uint8Array): Promise<{ sd: pkijs.SignedData; signer: pkijs.Certificate }> {
  const [, b, c, d] = sig.byteRange;
  const data = concatBytes(pdf.subarray(0, b), pdf.subarray(c, c + d));
  const sd = parseSignedData(sig.contents);
  let res: pkijs.SignedDataVerifyResult;
  try {
    res = (await sd.verify({ signer: 0, data: toArrayBuffer(data), extendedMode: true, checkChain: false })) as pkijs.SignedDataVerifyResult;
  } catch (e) {
    const r = e as { signatureVerified?: boolean; message?: string; date?: unknown };
    throw new VerifyError(
      `A assinatura não é válida para este documento (${r.message ?? "verificação falhou"}).`,
      "bad_signature",
    );
  }
  if (!res.signatureVerified || !res.signerCertificate) {
    throw new VerifyError("A assinatura não corresponde ao conteúdo do documento.", "bad_signature");
  }
  return { sd, signer: res.signerCertificate };
}

export interface QualifiedSignatureResult {
  signer: CertInfo;
  chain: CertInfo[];
  signingTime: string | null;
  subFilter: string | null;
  docTimestamps: number;
  newSha256: string;
}

export interface VerifyOptions {
  trust: TrustStore;
  policy?: QualifiedPolicy;
  /** Data para validar os certificados (por omissão, agora). */
  checkDate?: Date;
}

/**
 * Valida o PDF carregado por um signatário:
 *  1. os bytes anteriores mantêm-se intactos (atualização incremental);
 *  2. há exatamente uma assinatura nova (mais eventuais carimbos temporais);
 *  3. a assinatura é criptograficamente válida;
 *  4. o certificado é de assinatura qualificada do Cartão de Cidadão / CMD e encadeia até à ECRaizEstado.
 */
export async function verifyIncrementalQualifiedSignature(
  previous: Uint8Array,
  uploaded: Uint8Array,
  opts: VerifyOptions,
): Promise<QualifiedSignatureResult> {
  const policy = opts.policy ?? PT_CC_POLICY;
  if (uploaded.length <= previous.length || !bytesEqual(uploaded.subarray(0, previous.length), previous)) {
    throw new VerifyError(
      "O PDF carregado não corresponde ao documento descarregado do Signed. Assine o ficheiro descarregado sem o alterar ou guardar noutro programa.",
      "not_incremental",
    );
  }
  const before = findSignatures(previous).length;
  const all = findSignatures(uploaded);
  const added = all.filter((s) => s.byteRange[2] > previous.length);
  const approvals = added.filter((s) => !s.isDocTimestamp);
  if (all.length - added.length !== before) {
    throw new VerifyError("As assinaturas anteriores do documento foram alteradas.", "previous_changed");
  }
  if (approvals.length === 0) throw new VerifyError("Não foi encontrada nenhuma assinatura nova no PDF.", "no_signature");
  if (approvals.length > 1) throw new VerifyError("O PDF tem mais do que uma assinatura nova. Cada pessoa assina uma vez.", "multiple");

  const sig = approvals[0];
  if (sig.subFilter && !["ETSI.CAdES.detached", "adbe.pkcs7.detached"].includes(sig.subFilter)) {
    throw new VerifyError(`Tipo de assinatura não suportado (${sig.subFilter}).`, "subfilter");
  }
  // A última assinatura tem de cobrir o ficheiro inteiro (nada acrescentado depois sem estar assinado).
  const last = all.reduce((m, s) => (s.byteRange[2] + s.byteRange[3] > m.byteRange[2] + m.byteRange[3] ? s : m), all[0]);
  if (last.byteRange[2] + last.byteRange[3] !== uploaded.length) {
    throw new VerifyError("Foi acrescentado conteúdo ao PDF depois da assinatura.", "trailing_data");
  }
  // Carimbos temporais acrescentados depois: só verificamos a integridade.
  const stamps = added.filter((s) => s.isDocTimestamp);
  for (const ts of stamps) await verifyCms(ts, uploaded);

  const { sd, signer } = await verifyCms(sig, uploaded);

  // Cadeia de certificação.
  // ATENÇÃO: o pkijs remove certificados repetidos e valida o ÚLTIMO da lista. O certificado do
  // signatário tem de ser o último e não pode aparecer antes; caso contrário seria validada outra
  // cadeia (ex.: CAs verdadeiras acrescentadas pelo atacante a seguir a um certificado falso).
  const same = (a: pkijs.Certificate, b: pkijs.Certificate) => bytesEqual(new Uint8Array(a.tbsView), new Uint8Array(b.tbsView));
  const embedded = (sd.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
  const pool: pkijs.Certificate[] = [];
  for (const c of [...opts.trust.intermediates, ...embedded]) {
    if (!same(c, signer) && !pool.some((p) => same(p, c))) pool.push(c);
  }
  const engine = new pkijs.CertificateChainValidationEngine({
    trustedCerts: opts.trust.anchors,
    certs: [...pool, signer],
    checkDate: opts.checkDate ?? new Date(),
  });
  const chainRes = await engine.verify();
  const path = chainRes.certificatePath ?? [];
  if (!chainRes.result || path.length < 2 || !same(path[0], signer)) {
    console.warn(`cadeia CC recusada: ${chainRes.resultCode} ${chainRes.resultMessage}`);
    throw new VerifyError(
      "O certificado da assinatura não é um certificado qualificado do Cartão de Cidadão ou da Chave Móvel Digital (ou já não é válido).",
      "untrusted",
    );
  }
  const chain = path.map(certInfo);
  const s = certInfo(signer);
  if (!policy.signerIssuerCn.test(s.issuerCommonName)) {
    throw new VerifyError(
      "O certificado usado é de autenticação e não de assinatura. Na app Autenticação.gov use a opção de assinar o documento.",
      "not_signature_cert",
    );
  }
  if (!chain.some((c) => policy.requiredIntermediateCn.test(c.commonName))) {
    throw new VerifyError("A cadeia de certificação não passa pela entidade do Cartão de Cidadão.", "untrusted");
  }
  // keyUsage: nonRepudiation (bit 1) obrigatório num certificado de assinatura qualificada.
  const ku = signer.extensions?.find((e) => e.extnID === "2.5.29.15");
  if (ku) {
    const bits = new Uint8Array((ku.parsedValue as asn1js.BitString).valueBlock.valueHexView);
    if (!(bits[0] & 0x40)) {
      throw new VerifyError("O certificado não permite assinaturas com valor legal (sem não-repúdio).", "not_signature_cert");
    }
  }

  let signingTime: string | null = null;
  const st = signedAttr(sd, "1.2.840.113549.1.9.5") as (asn1js.UTCTime | asn1js.GeneralizedTime) | null;
  if (st && typeof (st as asn1js.UTCTime).toDate === "function") signingTime = (st as asn1js.UTCTime).toDate().toISOString();

  return {
    signer: s,
    chain,
    signingTime,
    subFilter: sig.subFilter,
    docTimestamps: stamps.length,
    newSha256: await sha256Hex(uploaded),
  };
}

/** Compara o certificado com o destinatário esperado (nº de identificação civil ou nome). */
export function matchSigner(
  cert: CertInfo,
  expected: { name: string; civil_id: string | null },
  nameMatches: (a: string, b: string) => boolean,
): { ok: boolean; reason?: string } {
  if (expected.civil_id) {
    const digits = (cert.serialNumberAttr ?? "").replace(/\D/g, "");
    if (digits.startsWith(expected.civil_id)) return { ok: true };
    return {
      ok: false,
      reason: `O documento foi assinado com o cartão de ${cert.commonName}, que não corresponde ao número de identificação civil indicado.`,
    };
  }
  const certName = [cert.commonName, cert.givenName, cert.surname].filter(Boolean).join(" ");
  if (nameMatches(expected.name, certName)) return { ok: true };
  return {
    ok: false,
    reason: `O documento foi assinado com o cartão de ${cert.commonName}, mas o convite é para ${expected.name}. Peça ao remetente para corrigir o nome ou indicar o nº de identificação civil.`,
  };
}
