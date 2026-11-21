// Motor criptográfico do pkijs com verificação ECDSA em JavaScript puro.
//
// A CA "Cartão de Cidadão 008" (que emite as CAs de assinatura do CC desde 2023 e a CMD 00007)
// usa uma chave ECDSA P-521, e as CAs de assinatura atuais usam P-384. O WebCrypto do runtime das
// Edge Functions do Supabase não suporta P-521 e falha ("Not implemented") em verificações P-384
// com SHA-256. Por isso TODAS as verificações ECDSA são feitas com @noble/curves (biblioteca
// auditada, sem dependências). RSA continua a usar o WebCrypto nativo.

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { p256, p384, p521 } from "@noble/curves/nist";

const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const CURVES = {
  "1.2.840.10045.3.1.7": p256,
  "1.3.132.0.34": p384,
  "1.3.132.0.35": p521,
} as const;
const ECDSA_HASH: Record<string, string> = {
  "1.2.840.10045.4.1": "SHA-1",
  "1.2.840.10045.4.3.2": "SHA-256",
  "1.2.840.10045.4.3.3": "SHA-384",
  "1.2.840.10045.4.3.4": "SHA-512",
};

function curveOf(pki: pkijs.PublicKeyInfo): string | null {
  if (pki.algorithm.algorithmId !== OID_EC_PUBLIC_KEY) return null;
  const params = pki.algorithm.algorithmParams;
  return params instanceof asn1js.ObjectIdentifier ? params.valueBlock.toString() : null;
}

class SignedCryptoEngine extends pkijs.CryptoEngine {
  override async verifyWithPublicKey(
    data: BufferSource,
    signature: asn1js.BitString | asn1js.OctetString,
    publicKeyInfo: pkijs.PublicKeyInfo,
    signatureAlgorithm: pkijs.AlgorithmIdentifier,
    shaAlgorithm: string | null = null,
  ): Promise<boolean> {
    const oid = curveOf(publicKeyInfo);
    const curve = oid ? CURVES[oid as keyof typeof CURVES] : undefined;
    if (oid && !curve) throw new Error(`Curva EC não suportada: ${oid}`);
    if (curve) {
      const hash = shaAlgorithm ?? ECDSA_HASH[signatureAlgorithm.algorithmId];
      if (!hash) throw new Error(`Algoritmo de assinatura não suportado: ${signatureAlgorithm.algorithmId}`);
      const bytes = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer.slice(
        (data as ArrayBufferView).byteOffset,
        (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength,
      );
      const digest = new Uint8Array(await crypto.subtle.digest(hash, bytes as ArrayBuffer));
      const pub = new Uint8Array(publicKeyInfo.subjectPublicKey.valueBlock.valueHexView);
      const sig = new Uint8Array(signature.valueBlock.valueHexView);
      try {
        return curve.verify(sig, digest, pub, { prehash: false, lowS: false, format: "der" });
      } catch {
        return false;
      }
    }
    return super.verifyWithPublicKey(data, signature, publicKeyInfo, signatureAlgorithm, shaAlgorithm ?? undefined);
  }
}

let installed = false;
/** Instala o motor (idempotente). Chamar antes de qualquer verificação pkijs. */
export function installCryptoEngine(): void {
  if (installed) return;
  pkijs.setEngine("signed", new SignedCryptoEngine({ name: "signed", crypto: globalThis.crypto }));
  installed = true;
}
