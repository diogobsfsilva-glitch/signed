// Modo de teste: login com emails autorizados individualmente e consulta dos emails não enviados.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import { execSync } from "node:child_process";

const status = JSON.parse(execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const URL_ = status.API_URL as string;
const ANON = status.ANON_KEY as string;
const admin = createClient(URL_, status.SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });

async function signIn(email: string): Promise<SupabaseClient> {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: "Teste12345!" });
  if (error) throw error;
  return c;
}
async function createUser(email: string) {
  return admin.auth.admin.createUser({ email, password: "Teste12345!", email_confirm: true });
}

let owner: SupabaseClient;
let other: SupabaseClient;
let docId: string;

beforeAll(async () => {
  await createUser("diogo@altishotels.com").catch(() => {});
  await createUser("ana@altishotels.com").catch(() => {});
  owner = await signIn("diogo@altishotels.com");
  other = await signIn("ana@altishotels.com");
  const ownerId = (await owner.auth.getUser()).data.user!.id;
  const otherId = (await other.auth.getUser()).data.user!.id;
  await admin.from("profiles").update({ role: "admin" }).eq("id", ownerId);
  await admin.from("profiles").update({ role: "user" }).eq("id", otherId);
  const { data: ws } = await owner.from("workspaces").select("id").order("created_at").limit(1).single();
  const { data: doc } = await owner.from("documents").insert({ workspace_id: ws!.id, owner_id: ownerId, title: "Teste modo de teste" }).select().single();
  docId = doc!.id;
  const p = await PDFDocument.create();
  p.addPage([595.28, 841.89]);
  const path = `${ws!.id}/${docId}/original.pdf`;
  await owner.storage.from("documents").upload(path, await p.save(), { contentType: "application/pdf" });
  await owner.from("documents").update({ original_path: path, page_count: 1, pages: [{ w: 595.28, h: 841.89 }] }).eq("id", docId);
  const rid = crypto.randomUUID();
  await owner.from("recipients").insert({ id: rid, document_id: docId, name: "Sofia Teste", email: "sofia.teste@gmail.com", role: "signer", signing_order: 1 });
  await owner.from("fields").insert({ document_id: docId, recipient_id: rid, type: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.08 });
  const jwt = (await owner.auth.getSession()).data.session!.access_token;
  const res = await fetch(`${URL_}/functions/v1/document-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ action: "send", document_id: docId }),
  });
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await admin.from("app_settings").update({ test_mode: false, allowed_emails: [] }).eq("id", 1);
});

describe("modo de teste", () => {
  it("desligado: login_options diz false e ninguém vê o texto dos emails", async () => {
    const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
    expect((await anon.rpc("login_options")).data).toEqual({ test_mode: false });
    const { data } = await owner.rpc("test_email_bodies", { p_document_id: docId });
    expect(data).toEqual([]);
  });

  it("emails fora dos domínios só entram se autorizados individualmente", async () => {
    const r1 = await createUser("intruso@gmail.com");
    expect(r1.error).toBeTruthy();
    await admin.from("app_settings").update({ allowed_emails: ["Teste.Signed@gmail.com"] }).eq("id", 1);
    const r2 = await createUser("teste.signed@gmail.com");
    expect(r2.error).toBeNull();
    const r3 = await createUser("outro.gmail@gmail.com");
    expect(r3.error).toBeTruthy();
  });

  it("ligado: o dono vê o link de convite; outro colaborador e o anónimo não", async () => {
    await admin.from("app_settings").update({ test_mode: true }).eq("id", 1);
    const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
    expect((await anon.rpc("login_options")).data).toEqual({ test_mode: true });

    const { data } = await owner.rpc("test_email_bodies", { p_document_id: docId });
    expect(data!.length).toBeGreaterThanOrEqual(1);
    expect(data!.some((x: { body_text: string }) => /\/s\/[A-Za-z0-9_-]+/.test(x.body_text))).toBe(true);

    expect((await other.rpc("test_email_bodies", { p_document_id: docId })).data).toEqual([]);
    expect((await anon.rpc("test_email_bodies", { p_document_id: docId })).error).toBeTruthy();
    // O corpo continua fora do alcance de leitura direta.
    expect((await owner.from("email_log").select("body_text").eq("document_id", docId)).error).toBeTruthy();
  });
});
