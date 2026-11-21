// Gera supabase/functions/_shared/trust-pt.ts a partir dos certificados em certs/pt/.
// Fonte: repositório oficial do Autenticação.gov (github.com/amagovpt/autenticacao.gov,
// pteid-mw-pt/_src/eidmw/misc/certs). Âncoras: ECRaizEstado 002 e MULTICERT Root 01
// (esta certifica a ECRaizEstado antiga, que emitiu "Cartão de Cidadão 003-005").
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = "certs/pt";
const anchors = new Set(["ECRaizEstado002.der", "Multicert_Root_01.der"]);
const out = { anchors: {}, intermediates: {} };
for (const f of readdirSync(dir).filter((f) => f.endsWith(".der")).sort()) {
  const b64 = readFileSync(join(dir, f)).toString("base64");
  (anchors.has(f) ? out.anchors : out.intermediates)[f.replace(/\.der$/, "")] = b64;
}
const ts = `// GERADO por scripts/build-trust-store.mjs — não editar à mão.
// Certificados públicos do Estado português (Cartão de Cidadão / Chave Móvel Digital).

export const PT_TRUST_ANCHORS: Record<string, string> = ${JSON.stringify(out.anchors, null, 2)};

export const PT_INTERMEDIATES: Record<string, string> = ${JSON.stringify(out.intermediates, null, 2)};
`;
writeFileSync("supabase/functions/_shared/trust-pt.ts", ts);
console.log("anchors:", Object.keys(out.anchors).length, "intermediates:", Object.keys(out.intermediates).length);
