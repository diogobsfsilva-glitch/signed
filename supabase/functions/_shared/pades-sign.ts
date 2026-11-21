// Selo eletrónico da plataforma (PAdES, CAdES destacado) aplicado aos PDFs finais.
// Garante que qualquer alteração posterior ao documento é detetável.

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from "pdf-lib";
import { concatBytes, fromBase64, toArrayBuffer, toHex } from "./util.ts";
import { parseCertificate } from "./pades-verify.ts";

export interface SealKey {
  /** Certificado do selo primeiro, seguido das CAs (DER). */
  chain: pkijs.Certificate[];
  privateKey: CryptoKey;
}

function pemBlocks(pem: string, label: string): Uint8Array[] {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`, "g");
  return [...pem.matchAll(re)].map((m) => fromBase64(m[1]));
}

const CURVES: Record<string, string> = { "1.2.840.10045.3.1.7": "P-256", "1.3.132.0.34": "P-384" };

/** Lê o certificado (PEM, pode incluir a cadeia) e a chave privada PKCS#8 (PEM, RSA ou EC P-256/P-384). */
export async function loadSealKey(certPem: string, keyPem: string): Promise<SealKey> {
  const chain = pemBlocks(certPem, "CERTIFICATE").map(parseCertificate);
  if (chain.length === 0) throw new Error("SEAL_CERT_PEM sem certificados");
  const keyDer = pemBlocks(keyPem, "PRIVATE KEY")[0];
  if (!keyDer) throw new Error("SEAL_KEY_PEM tem de estar em formato PKCS#8 (BEGIN PRIVATE KEY)");
  const spki = chain[0].subjectPublicKeyInfo.algorithm;
  const isEc = spki.algorithmId === "1.2.840.10045.2.1";
  const curve = isEc ? CURVES[(spki.algorithmParams as asn1js.ObjectIdentifier).valueBlock.toString()] : null;
  if (isEc && !curve) throw new Error("Curva EC não suportada para o selo (use RSA, P-256 ou P-384)");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(keyDer),
    isEc ? { name: "ECDSA", namedCurve: curve! } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return { chain, privateKey };
}

/** CMS SignedData destacado (CAdES-BES) sobre `data`. */
export async function createDetachedCades(data: Uint8Array, key: SealKey): Promise<Uint8Array> {
  const signerCert = key.chain[0];
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(data)));
  const certHash = new Uint8Array(await crypto.subtle.digest("SHA-256", signerCert.toSchema(true).toBER(false)));

  // ESS signing-certificate-v2 (obrigatório em CAdES/PAdES)
  const essCertIdV2 = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: toArrayBuffer(certHash) })] })],
      }),
    ],
  });

  const attrs = [
    new pkijs.Attribute({ type: "1.2.840.113549.1.9.3", values: [new asn1js.ObjectIdentifier({ value: "1.2.840.113549.1.7.1" })] }),
    new pkijs.Attribute({ type: "1.2.840.113549.1.9.4", values: [new asn1js.OctetString({ valueHex: toArrayBuffer(digest) })] }),
    new pkijs.Attribute({ type: "1.2.840.113549.1.9.16.2.47", values: [essCertIdV2] }),
  ];

  const sd = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: "1.2.840.113549.1.7.1" }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: signerCert.issuer, serialNumber: signerCert.serialNumber }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: attrs }),
      }),
    ],
    certificates: key.chain,
  });
  await sd.sign(key.privateKey, 0, "SHA-256");
  const ci = new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.SIGNED_DATA, content: sd.toSchema(true) });
  return new Uint8Array(ci.toSchema().toBER(false));
}

const PLACEHOLDER_BYTES = 16384;
const BR_PLACEHOLDER = "**********";

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

/** Aplica o selo da plataforma a um PDF (gera um PDF novo, não incremental). */
export async function sealPdf(
  pdfBytes: Uint8Array,
  key: SealKey,
  info: { reason: string; name: string; location?: string },
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const ctx = doc.context;
  const byteRange = PDFArray.withContext(ctx);
  byteRange.push(PDFNumber.of(0));
  for (let i = 0; i < 3; i++) byteRange.push(PDFName.of(BR_PLACEHOLDER));

  const sigDict = ctx.obj({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
    SubFilter: "ETSI.CAdES.detached",
    ByteRange: byteRange,
    Contents: PDFHexString.of("0".repeat(PLACEHOLDER_BYTES * 2)),
    Reason: PDFString.of(info.reason),
    Name: PDFString.of(info.name),
    Location: PDFString.of(info.location ?? "Portugal"),
    M: PDFString.fromDate(new Date()),
  });
  const sigRef = ctx.register(sigDict);
  const firstPage = doc.getPage(0);
  const widget = ctx.obj({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    Rect: [0, 0, 0, 0],
    V: sigRef,
    T: PDFString.of(`Selo ${info.name} ${Date.now()}`),
    F: 132,
    P: firstPage.ref,
  });
  const widgetRef = ctx.register(widget);
  firstPage.node.addAnnot(widgetRef);
  const acro = doc.catalog.getOrCreateAcroForm();
  acro.addField(widgetRef);
  acro.dict.set(PDFName.of("SigFlags"), PDFNumber.of(3));

  const out = await doc.save({ useObjectStreams: false });
  return await fillSignaturePlaceholder(out, (data) => createDetachedCades(data, key));
}

/**
 * Preenche o último marcador de assinatura de um PDF (ByteRange com asteriscos e
 * Contents a zeros) com o ByteRange real e a assinatura devolvida por `sign`.
 */
export async function fillSignaturePlaceholder(
  out: Uint8Array,
  sign: (signedBytes: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const text = latin1(out);
  const brRe = /\/ByteRange\s*\[\s*0\s+\/\*{10}\s+\/\*{10}\s+\/\*{10}\s*\]/g;
  let brMatch: RegExpExecArray | null = null;
  for (const m of text.matchAll(brRe)) brMatch = m as RegExpExecArray;
  if (!brMatch) throw new Error("Assinatura: marcador ByteRange não encontrado");
  const zeros = "<" + "0".repeat(64);
  let contentsStart = text.indexOf(zeros, brMatch.index);
  if (contentsStart < 0) contentsStart = text.lastIndexOf(zeros, brMatch.index);
  const contentsEnd = text.indexOf(">", contentsStart) + 1;
  if (contentsStart < 0 || contentsEnd <= contentsStart) throw new Error("Assinatura: marcador Contents não encontrado");
  const capacity = contentsEnd - contentsStart - 2;

  const b = contentsStart;
  const c = contentsEnd;
  const d = out.length - c;
  const brText = `/ByteRange [0 ${b} ${c} ${d}]`;
  if (brText.length > brMatch[0].length) throw new Error("Assinatura: ByteRange não cabe no espaço reservado");
  const enc = new TextEncoder();
  out.set(enc.encode(brText.padEnd(brMatch[0].length, " ")), brMatch.index!);

  const cms = await sign(concatBytes(out.subarray(0, b), out.subarray(c)));
  const hex = toHex(cms);
  if (hex.length > capacity) throw new Error("Assinatura maior do que o espaço reservado");
  out.set(enc.encode(hex.padEnd(capacity, "0")), b + 1);
  return out;
}
