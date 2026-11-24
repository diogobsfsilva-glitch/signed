// Pacotes de documentos: vários documentos num só envio, separados na conclusão.
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import { execSync } from "node:child_process";

const status = JSON.parse(execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const URL_ = status.API_URL as string;
const ANON = status.ANON_KEY as string;
const admin = createClient(URL_, status.SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function fn(name: string, body: unknown, jwt?: string) {
  const res = await fetch(`${URL_}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${jwt ?? ANON}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
}
async function lastEmail(to: string, kind: string): Promise<string> {
  const { data } = await admin.from("email_log").select("body_text").eq("to_email", to).eq("kind", kind).order("id", { ascending: false }).limit(1);
  return data?.[0]?.body_text ?? "";
}
async function login(token: string, email: string): Promise<string> {
  expect((await fn("signer-api", { action: "send-otp", token })).ok).toBe(true);
  const code = /^\s*(\d{6})\s*$/m.exec(await lastEmail(email, "otp"))![1];
  return (await fn("signer-api", { action: "verify-otp", token, code })).session;
}

let owner: SupabaseClient;
let jwt: string;
let ws: string;
let ownerId: string;

beforeAll(async () => {
  await admin.auth.admin.createUser({ email: "diogo@altishotels.com", password: "Teste12345!", email_confirm: true, user_metadata: { full_name: "Diogo Silva" } }).catch(() => {});
  owner = createClient(URL_, ANON, { auth: { persistSession: false } });
  await owner.auth.signInWithPassword({ email: "diogo@altishotels.com", password: "Teste12345!" });
  jwt = (await owner.auth.getSession()).data.session!.access_token;
  ownerId = (await owner.auth.getUser()).data.user!.id;
  ws = (await owner.from("workspaces").select("id").order("created_at").limit(1).single()).data!.id;
});

async function packageDoc(title: string, parts: { name: string; pages: number }[], opts: { template?: boolean } = {}) {
  const { data: doc } = await owner.from("documents").insert({ workspace_id: ws, owner_id: ownerId, title, is_template: !!opts.template }).select().single();
  const pdf = await PDFDocument.create();
  const total = parts.reduce((a, p) => a + p.pages, 0);
  for (let i = 0; i < total; i++) pdf.addPage([595.28, 841.89]);
  const path = `${ws}/${doc!.id}/original.pdf`;
  await owner.storage.from("documents").upload(path, await pdf.save(), { contentType: "application/pdf" });
  const pages = Array.from({ length: total }, () => ({ w: 595.28, h: 841.89 }));
  const { error } = await owner.from("documents").update({ original_path: path, page_count: total, pages, parts }).eq("id", doc!.id);
  expect(error).toBeNull();
  return doc!;
}

describe("pacotes de documentos", () => {
  it("a base de dados recusa uma lista de partes inválida", async () => {
    const doc = await packageDoc(`Pacote inválido ${Date.now()}`, [{ name: "A", pages: 1 }]);
    for (const bad of [[], [{ name: "", pages: 1 }], [{ name: "A", pages: 0 }], [{ name: "A" }], "x", [{ name: "A", pages: 1.5 }]]) {
      expect((await owner.from("documents").update({ parts: bad }).eq("id", doc.id)).error, JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("um só convite, assinatura em vários documentos, cópias separadas com selo", async () => {
    const email = `pacote.${Date.now()}@exemplo.pt`;
    const doc = await packageDoc(`Admissão ${Date.now()}`, [{ name: "Contrato de trabalho", pages: 2 }, { name: "Declaração RGPD", pages: 1 }]);
    const rid = crypto.randomUUID();
    await owner.from("recipients").insert({ id: rid, document_id: doc.id, name: "Joana Costa", email, role: "signer", signing_order: 1 });
    await owner.from("fields").insert([
      { document_id: doc.id, recipient_id: rid, type: "signature", page: 2, x: 0.1, y: 0.8, w: 0.3, h: 0.08 },
      { document_id: doc.id, recipient_id: rid, type: "signature", page: 3, x: 0.1, y: 0.8, w: 0.3, h: 0.08 },
    ]);
    // Lista de partes que não bate com o PDF: o envio é recusado.
    await owner.from("documents").update({ parts: [{ name: "Contrato de trabalho", pages: 2 }, { name: "Declaração RGPD", pages: 2 }] }).eq("id", doc.id);
    const bad = await fn("document-actions", { action: "send", document_id: doc.id }, jwt);
    expect(bad.status).toBe(422);
    expect(bad.error).toMatch(/pacote não corresponde/);
    await owner.from("documents").update({ parts: [{ name: "Contrato de trabalho", pages: 2 }, { name: "Declaração RGPD", pages: 1 }] }).eq("id", doc.id);
    expect((await fn("document-actions", { action: "send", document_id: doc.id }, jwt)).ok).toBe(true);

    const invite = await lastEmail(email, "invite");
    expect(invite).toMatch(/inclui 2 documentos/);
    expect(invite).toMatch(/Contrato de trabalho/);
    expect(invite).toMatch(/Declaração RGPD/);
    const token = /\/s\/([A-Za-z0-9_-]+)/.exec(invite)![1];
    const session = await login(token, email);
    const l = await fn("signer-api", { action: "load", token, session });
    expect(l.document.parts).toEqual([{ name: "Contrato de trabalho", pages: 2 }, { name: "Declaração RGPD", pages: 1 }]);
    const values = Object.fromEntries(l.fields.map((f: { id: string }) => [f.id, PNG]));
    expect((await fn("signer-api", { action: "submit", token, session, values })).ok).toBe(true);

    const { data: done } = await admin.from("documents").select("status, final_path, audit_path").eq("id", doc.id).single();
    expect(done!.status).toBe("completed");
    const full = await PDFDocument.load(new Uint8Array(await (await admin.storage.from("documents").download(done!.final_path!)).data!.arrayBuffer()));
    expect(full.getPageCount()).toBe(3);
    const pages = [];
    for (const n of [1, 2]) {
      const dl = await owner.storage.from("documents").download(`${ws}/${doc.id}/final_part_${n}.pdf`);
      expect(dl.error).toBeNull();
      const bytes = new Uint8Array(await dl.data!.arrayBuffer());
      // Cada cópia separada tem o seu próprio selo (assinatura PAdES do Signed).
      expect(new TextDecoder("latin1").decode(bytes)).toMatch(/\/ByteRange/);
      pages.push((await PDFDocument.load(bytes)).getPageCount());
    }
    expect(pages).toEqual([2, 1]);
  });

  it("modelos e cópias mantêm as partes", async () => {
    const tpl = await packageDoc(`Modelo pacote ${Date.now()}`, [{ name: "Termo", pages: 1 }, { name: "Regulamento", pages: 2 }], { template: true });
    const { data, error } = await owner.rpc("instantiate_document", { p_source: tpl.id, p_as_template: false, p_title: "Cópia" });
    expect(error).toBeNull();
    const id = (Array.isArray(data) ? data[0] : data).new_document_id;
    const { data: copy } = await owner.from("documents").select("parts, page_count").eq("id", id).single();
    expect(copy!.parts).toEqual([{ name: "Termo", pages: 1 }, { name: "Regulamento", pages: 2 }]);
    expect(copy!.page_count).toBe(3);
  });
});
