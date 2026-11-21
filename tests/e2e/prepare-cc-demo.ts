// Prepara um documento em modo CC (para testar a interface do assistente) e um PDF assinado com a PKI de teste.
// Uso: npx vite-node tests/e2e/prepare-cc-demo.ts <pasta-de-saída>
import { createClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { appendIncrementalSignature, testKey } from "../helpers/incremental.ts";

const out = process.argv[2] ?? ".";
const st = JSON.parse(execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const owner = createClient(st.API_URL, st.ANON_KEY, { auth: { persistSession: false } });
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
await owner.auth.signInWithPassword({ email: "diogo@altishotels.com", password: "Teste12345!" });
const jwt = (await owner.auth.getSession()).data.session!.access_token;
const me = (await owner.auth.getUser()).data.user!;
const { data: ws } = await owner.from("workspaces").select("id").limit(1).single();

const d = await PDFDocument.create();
const f = await d.embedFont(StandardFonts.HelveticaBold);
const p = d.addPage([595.28, 841.89]);
p.drawText("ACORDO DE CONFIDENCIALIDADE", { x: 60, y: 770, size: 16, font: f });
const pdf = await d.save({ useObjectStreams: false });

const { data: doc } = await owner.from("documents").insert({ workspace_id: ws!.id, owner_id: me.id, title: "Acordo de confidencialidade (CC)", signature_mode: "qualified" }).select().single();
const path = `${ws!.id}/${doc!.id}/original.pdf`;
await owner.storage.from("documents").upload(path, pdf, { contentType: "application/pdf" });
await owner.from("documents").update({ original_path: path, page_count: 1, pages: [{ w: 595.28, h: 841.89 }] }).eq("id", doc!.id);
const rid = crypto.randomUUID();
await owner.from("recipients").insert({ id: rid, document_id: doc!.id, name: "Maria Silva", email: "maria.ccui@exemplo.pt", role: "signer", signing_order: 1 });
await owner.from("fields").insert({ document_id: doc!.id, recipient_id: rid, type: "signature", page: 1, x: 0.5, y: 0.8, w: 0.4, h: 0.09 });
const res = await fetch(`${st.API_URL}/functions/v1/document-actions`, { method: "POST", headers: { "Content-Type": "application/json", apikey: st.ANON_KEY, Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ action: "send", document_id: doc!.id }) });
console.error("send:", res.status);
const { data: full } = await admin.from("documents").select("current_path").eq("id", doc!.id).single();
const dl = await admin.storage.from("documents").download(full!.current_path);
const prepared = new Uint8Array(await dl.data!.arrayBuffer());
writeFileSync(`${out}/prepared.pdf`, prepared);
writeFileSync(`${out}/assinado-maria.pdf`, await appendIncrementalSignature(prepared, await testKey("maria", ["sigca", "cc008"])));
writeFileSync(`${out}/assinado-joao.pdf`, await appendIncrementalSignature(prepared, await testKey("joao", ["sigca", "cc008"])));
console.log(doc!.id);
