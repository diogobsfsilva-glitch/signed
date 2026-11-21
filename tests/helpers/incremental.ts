// Simula o que a app Autenticação.gov faz: acrescenta uma assinatura PAdES por
// atualização incremental, sem tocar nos bytes anteriores.
import { readFileSync } from "node:fs";
import { createDetachedCades, fillSignaturePlaceholder, loadSealKey, type SealKey } from "../../supabase/functions/_shared/pades-sign.ts";
import { concatBytes } from "../../supabase/functions/_shared/util.ts";

const PKI = new URL("../fixtures/pki/", import.meta.url);
export async function testKey(name: string, chain: string[] = []): Promise<SealKey> {
  const pem = [name, ...chain].map((n) => readFileSync(new URL(`${n}.pem`, PKI), "utf8")).join("\n");
  return loadSealKey(pem, readFileSync(new URL(`${name}.p8`, PKI), "utf8"));
}
export function testPem(name: string): string {
  return readFileSync(new URL(`${name}.pem`, PKI), "utf8");
}

function latin1(b: Uint8Array) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

export async function appendIncrementalSignature(
  pdf: Uint8Array,
  key: SealKey,
  opts: { subFilter?: string; type?: string } = {},
): Promise<Uint8Array> {
  const text = latin1(pdf);
  const startxref = Number([...text.matchAll(/startxref\s+(\d+)/g)].at(-1)![1]);
  const size = Number([...text.matchAll(/\/Size\s+(\d+)/g)].at(-1)![1]);
  const root = [...text.matchAll(/\/Root\s+(\d+\s+\d+\s+R)/g)].at(-1)![1];
  const n = size;
  const head = new TextEncoder().encode("\n");
  const objOffset = pdf.length + head.length;
  const obj =
    `${n} 0 obj\n<< /Type /${opts.type ?? "Sig"} /Filter /Adobe.PPKLite /SubFilter /${opts.subFilter ?? "ETSI.CAdES.detached"} ` +
    `/ByteRange [0 /********** /********** /**********] /Contents <${"0".repeat(16384)}> /M (D:20261121120000Z) >>\nendobj\n`;
  const xrefOffset = objOffset + obj.length;
  const tail =
    `xref\n${n} 1\n${String(objOffset).padStart(10, "0")} 00000 n \n` +
    `trailer\n<< /Size ${n + 1} /Root ${root} /Prev ${startxref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const out = concatBytes(pdf, head, new TextEncoder().encode(obj + tail));
  return fillSignaturePlaceholder(out, (data) => createDetachedCades(data, key));
}
