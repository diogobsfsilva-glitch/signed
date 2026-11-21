// Teste ponta-a-ponta da API contra o Supabase local (npx supabase start + functions serve).
// Corre com: npm run test:e2e
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { execSync } from "node:child_process";
import { appendIncrementalSignature, testKey } from "../helpers/incremental.ts";
import { findSignatures } from "../../supabase/functions/_shared/pades-verify.ts";

const status = JSON.parse(execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const URL_ = status.API_URL as string;
const ANON = status.ANON_KEY as string;
const SERVICE = status.SERVICE_ROLE_KEY as string;
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function ensureUser(email: string, name: string): Promise<SupabaseClient> {
  await admin.auth.admin.createUser({ email, password: "Teste12345!", email_confirm: true, user_metadata: { full_name: name } }).catch(() => {});
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: "Teste12345!" });
  if (error) throw error;
  return c;
}

async function pdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([595.28, 841.89]);
  p.drawText("Contrato de prestação de serviços — teste", { x: 50, y: 780, size: 14, font: f });
  return d.save({ useObjectStreams: false });
}

async function fn(name: string, body: unknown, jwt?: string) {
  const res = await fetch(`${URL_}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${jwt ?? ANON}` },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  return { status: res.status, ...j };
}

async function lastEmail(to: string, kind: string): Promise<string> {
  const { data } = await admin.from("email_log").select("body_text").eq("to_email", to).eq("kind", kind).order("id", { ascending: false }).limit(1);
  return data?.[0]?.body_text ?? "";
}

async function tokenFor(email: string): Promise<string> {
  const body = await lastEmail(email, "invite");
  const m = /\/s\/([A-Za-z0-9_-]+)/.exec(body);
  if (!m) throw new Error(`Sem convite para ${email}`);
  return m[1];
}

const sessions = new Map<string, string>();
async function login(token: string, email: string): Promise<string> {
  if (sessions.has(token)) return sessions.get(token)!;
  const s = await fn("signer-api", { action: "send-otp", token });
  expect(s.ok).toBe(true);
  const code = /^\s*(\d{6})\s*$/m.exec(await lastEmail(email, "otp"))![1];
  const wrong = await fn("signer-api", { action: "verify-otp", token, code: "000000" === code ? "111111" : "000000" });
  expect(wrong.status).toBe(400);
  const v = await fn("signer-api", { action: "verify-otp", token, code });
  expect(v.session).toBeTruthy();
  sessions.set(token, v.session);
  return v.session;
}

let owner: SupabaseClient;
let other: SupabaseClient;
let jwt: string;
let ws: string;

async function createDoc(mode: "simple" | "qualified", recipients: { name: string; email: string; civil_id?: string }[], extraFields = true) {
  const { data: me } = await owner.auth.getUser();
  const { data: doc, error } = await owner
    .from("documents")
    .insert({ workspace_id: ws, owner_id: me.user!.id, title: `Contrato ${mode} ${Date.now()}`, signature_mode: mode, sequential: true, message: "Por favor assine." })
    .select()
    .single();
  if (error) throw error;
  const path = `${ws}/${doc.id}/original.pdf`;
  const up = await owner.storage.from("documents").upload(path, await pdf(), { contentType: "application/pdf" });
  expect(up.error).toBeNull();
  await owner.from("documents").update({ original_path: path, page_count: 1, pages: [{ w: 595.28, h: 841.89 }] }).eq("id", doc.id);
  const rows = recipients.map((r, i) => ({ id: crypto.randomUUID(), document_id: doc.id, name: r.name, email: r.email, role: "signer", signing_order: i + 1, civil_id: r.civil_id ?? null }));
  const rr = await owner.from("recipients").insert(rows);
  expect(rr.error).toBeNull();
  const fields = rows.flatMap((r, i) => [
    { document_id: doc.id, recipient_id: r.id, type: "signature", page: 1, x: 0.1 + i * 0.45, y: 0.8, w: 0.35, h: 0.08 },
    ...(extraFields ? [{ document_id: doc.id, recipient_id: r.id, type: "text", page: 1, x: 0.1 + i * 0.45, y: 0.7, w: 0.35, h: 0.03, label: "Cargo" }] : []),
  ]);
  const fr = await owner.from("fields").insert(fields);
  expect(fr.error).toBeNull();
  return { doc, rows };
}

beforeAll(async () => {
  owner = await ensureUser("diogo@altishotels.com", "Diogo Silva");
  other = await ensureUser("ana@altishotels.com", "Ana Costa");
  jwt = (await owner.auth.getSession()).data.session!.access_token;
  const { data } = await owner.from("workspaces").select("id").limit(1).single();
  ws = data!.id;
});

describe("segurança (RLS)", () => {
  it("outro colaborador não vê nem altera documentos alheios", async () => {
    const { doc } = await createDoc("simple", [{ name: "Externo", email: "ext@exemplo.pt" }]);
    const { data } = await other.from("documents").select("id").eq("id", doc.id);
    expect(data).toHaveLength(0);
    const { data: upd } = await other.from("documents").update({ title: "hack" }).eq("id", doc.id).select();
    expect(upd ?? []).toHaveLength(0);
    const dl = await other.storage.from("documents").download(`${ws}/${doc.id}/original.pdf`);
    expect(dl.error).toBeTruthy();
  });

  it("o cliente não consegue mudar o estado nem ler tokens", async () => {
    const { doc } = await createDoc("simple", [{ name: "Externo", email: "ext2@exemplo.pt" }]);
    const st = await owner.from("documents").update({ status: "completed" }).eq("id", doc.id);
    expect(st.error).toBeTruthy();
    const tk = await owner.from("recipients").select("token_hash").eq("document_id", doc.id);
    expect(tk.error).toBeTruthy();
    const au = await owner.from("audit_events").delete().eq("document_id", doc.id);
    expect(au.error ?? (au.count === 0 ? null : "x")).toBeDefined();
    const { data: ev } = await owner.from("audit_events").select("id").eq("document_id", doc.id);
    expect(ev!.length).toBeGreaterThan(0);
  });

  it("não é possível apontar o original para o ficheiro de outro documento", async () => {
    const { doc: a } = await createDoc("simple", [{ name: "Externo", email: "ext4@exemplo.pt" }]);
    const { doc: b } = await createDoc("simple", [{ name: "Externo", email: "ext5@exemplo.pt" }]);
    const r = await owner.from("documents").update({ original_path: `${ws}/${a.id}/original.pdf` }).eq("id", b.id);
    expect(r.error?.message).toContain("Caminho do ficheiro inválido");
  });

  it("outro colaborador não pode enviar o documento", async () => {
    const { doc } = await createDoc("simple", [{ name: "Externo", email: "ext3@exemplo.pt" }]);
    const otherJwt = (await other.auth.getSession()).data.session!.access_token;
    const r = await fn("document-actions", { action: "send", document_id: doc.id }, otherJwt);
    expect(r.status).toBe(403);
  });
});

describe("fluxo com assinatura simples", () => {
  it("dois signatários em sequência até à conclusão", async () => {
    const { doc } = await createDoc("simple", [
      { name: "Maria Fernandes", email: "maria.s@exemplo.pt" },
      { name: "João Costa", email: "joao.s@exemplo.pt" },
    ]);
    const sent = await fn("document-actions", { action: "send", document_id: doc.id }, jwt);
    expect(sent.ok).toBe(true);
    // Só a Maria foi notificada.
    const t1 = await tokenFor("maria.s@exemplo.pt");
    await expect(tokenFor("joao.s@exemplo.pt")).rejects.toThrow();

    const s1 = await login(t1, "maria.s@exemplo.pt");
    const l1 = await fn("signer-api", { action: "load", token: t1, session: s1 });
    expect(l1.step).toBe("sign_simple");
    expect(l1.fields).toHaveLength(2);
    const bad = await fn("signer-api", { action: "submit", token: t1, session: s1, values: {} });
    expect(bad.status).toBe(422);
    const values = Object.fromEntries(l1.fields.map((f: { id: string; type: string }) => [f.id, f.type === "signature" ? PNG : "Diretora"]));
    const ok = await fn("signer-api", { action: "submit", token: t1, session: s1, values });
    expect(ok.ok).toBe(true);

    const t2 = await tokenFor("joao.s@exemplo.pt");
    const s2 = await login(t2, "joao.s@exemplo.pt");
    const l2 = await fn("signer-api", { action: "load", token: t2, session: s2 });
    expect(l2.others.length).toBe(2); // vê o que a Maria preencheu
    const v2 = Object.fromEntries(l2.fields.map((f: { id: string; type: string }) => [f.id, f.type === "signature" ? PNG : "Gestor"]));
    expect((await fn("signer-api", { action: "submit", token: t2, session: s2, values: v2 })).ok).toBe(true);

    const { data: final } = await admin.from("documents").select("*").eq("id", doc.id).single();
    expect(final.status).toBe("completed");
    expect(final.final_path).toBeTruthy();
    expect(final.audit_path).toBeTruthy();
    const f = await owner.storage.from("documents").download(final.final_path);
    const bytes = new Uint8Array(await f.data!.arrayBuffer());
    expect(findSignatures(bytes)).toHaveLength(1); // selo da plataforma
    const { data: chain } = await owner.rpc("verify_audit_chain", { p_document_id: doc.id });
    expect(chain).toBe(true);
    const { data: done } = await admin.from("email_log").select("to_email").eq("document_id", doc.id).eq("kind", "completed");
    expect(done!.map((d) => d.to_email).sort()).toEqual(["diogo@altishotels.com", "joao.s@exemplo.pt", "maria.s@exemplo.pt"]);
  });

  it("rejeitar termina o documento e avisa o remetente", async () => {
    const { doc } = await createDoc("simple", [{ name: "Rui Lopes", email: "rui@exemplo.pt" }]);
    await fn("document-actions", { action: "send", document_id: doc.id }, jwt);
    const t = await tokenFor("rui@exemplo.pt");
    const s = await login(t, "rui@exemplo.pt");
    expect((await fn("signer-api", { action: "decline", token: t, session: s, reason: "Valores errados" })).ok).toBe(true);
    const { data } = await admin.from("documents").select("status").eq("id", doc.id).single();
    expect(data!.status).toBe("declined");
    expect(await lastEmail("diogo@altishotels.com", "declined")).toContain("Valores errados");
  });

  it("cancelar invalida os links", async () => {
    const { doc } = await createDoc("simple", [{ name: "Rita", email: "rita@exemplo.pt" }]);
    await fn("document-actions", { action: "send", document_id: doc.id }, jwt);
    const t = await tokenFor("rita@exemplo.pt");
    expect((await fn("document-actions", { action: "cancel", document_id: doc.id }, jwt)).ok).toBe(true);
    expect((await fn("signer-api", { action: "start", token: t })).status).toBe(404);
  });
});

describe("fluxo com Cartão de Cidadão (PKI de teste)", () => {
  it("preenche, assina com CC em sequência e conclui com o PDF assinado intacto", async () => {
    const { doc } = await createDoc("qualified", [
      { name: "Maria Silva", email: "maria.cc@exemplo.pt" },
      { name: "João Costa", email: "joao.cc@exemplo.pt", civil_id: "98765432" },
    ]);
    expect((await fn("document-actions", { action: "send", document_id: doc.id }, jwt)).ok).toBe(true);

    // Fase de preenchimento: Maria e depois João preenchem o "Cargo".
    for (const [email, cargo] of [["maria.cc@exemplo.pt", "Diretora"], ["joao.cc@exemplo.pt", "Gestor"]]) {
      const t = await tokenFor(email);
      const s = await login(t, email);
      const l = await fn("signer-api", { action: "load", token: t, session: s });
      expect(l.step).toBe("fill");
      const editable = l.fields.filter((f: { editable: boolean }) => f.editable);
      expect(editable).toHaveLength(1);
      expect((await fn("signer-api", { action: "submit", token: t, session: s, values: { [editable[0].id]: cargo } })).ok).toBe(true);
    }
    const { data: prepared } = await admin.from("documents").select("phase, prepared_path, current_path").eq("id", doc.id).single();
    expect(prepared!.phase).toBe("sign");

    async function ccSign(email: string, key: string, chain: string[]) {
      const t = await tokenFor(email);
      const s = await login(t, email);
      const l = await fn("signer-api", { action: "load", token: t, session: s });
      expect(l.step).toBe("sign_cc");
      const dl = await fn("signer-api", { action: "cc-download", token: t, session: s });
      const current = new Uint8Array(await (await fetch(dl.url)).arrayBuffer());
      const signed = await appendIncrementalSignature(current, await testKey(key, chain));
      const up = await fn("signer-api", { action: "cc-upload-url", token: t, session: s });
      const anonClient = createClient(URL_, ANON, { auth: { persistSession: false } });
      const u = await anonClient.storage.from("documents").uploadToSignedUrl(up.path, up.uploadToken, signed, { contentType: "application/pdf" });
      expect(u.error).toBeNull();
      return fn("signer-api", { action: "cc-submit", token: t, session: s, path: up.path });
    }

    // O João tenta assinar fora da vez → recusado.
    const tj = await tokenFor("joao.cc@exemplo.pt");
    const sj = await login(tj, "joao.cc@exemplo.pt");
    expect((await fn("signer-api", { action: "cc-download", token: tj, session: sj })).status).toBe(409);

    // Maria assina com o cartão do João → recusado (pessoa errada).
    const wrong = await ccSign("maria.cc@exemplo.pt", "joao", ["sigca", "cc008"]);
    expect(wrong.status).toBe(422);
    expect(wrong.code).toBe("wrong_person");

    // Maria assina com o próprio cartão.
    const r1 = await ccSign("maria.cc@exemplo.pt", "maria", ["sigca", "cc008"]);
    expect(r1.ok).toBe(true);
    expect(r1.signer).toBe("Maria Fernandes Silva");

    // João (validado por nº de identificação civil).
    const r2 = await ccSign("joao.cc@exemplo.pt", "joao", ["sigca", "cc008"]);
    expect(r2.ok).toBe(true);
    expect(r2.completed).toBe(true);

    const { data: final } = await admin.from("documents").select("*").eq("id", doc.id).single();
    expect(final.status).toBe("completed");
    const f = await owner.storage.from("documents").download(final.final_path);
    const bytes = new Uint8Array(await f.data!.arrayBuffer());
    expect(findSignatures(bytes)).toHaveLength(2); // as duas assinaturas CC, sem alterações
    const { data: rec } = await owner.from("recipients").select("name, cert_subject").eq("document_id", doc.id).order("signing_order");
    expect(rec![0].cert_subject).toContain("Maria Fernandes Silva");
    const { data: ev } = await owner.from("audit_events").select("event").eq("document_id", doc.id).order("id");
    expect(ev!.map((e) => e.event)).toEqual(expect.arrayContaining(["document.prepared", "recipient.cc_rejected", "recipient.cc_signed", "document.completed"]));
  });
});

describe("Cartão de Cidadão — hierarquia EC (P-521) no runtime do Supabase", () => {
  it("aceita assinatura cuja cadeia passa por uma CA P-521", async () => {
    const { doc } = await createDoc("qualified", [{ name: "Ana Ribeiro", email: "ana.ec@exemplo.pt" }], false);
    expect((await fn("document-actions", { action: "send", document_id: doc.id }, jwt)).ok).toBe(true);
    const t = await tokenFor("ana.ec@exemplo.pt");
    const s = await login(t, "ana.ec@exemplo.pt");
    const dl = await fn("signer-api", { action: "cc-download", token: t, session: s });
    const current = new Uint8Array(await (await fetch(dl.url)).arrayBuffer());
    const signed = await appendIncrementalSignature(current, await testKey("ana_ec", ["sigca_ec"]));
    const up = await fn("signer-api", { action: "cc-upload-url", token: t, session: s });
    const anonClient = createClient(URL_, ANON, { auth: { persistSession: false } });
    await anonClient.storage.from("documents").uploadToSignedUrl(up.path, up.uploadToken, signed, { contentType: "application/pdf" });
    const r = await fn("signer-api", { action: "cc-submit", token: t, session: s, path: up.path });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.completed).toBe(true);
  });
});

describe("agendador", () => {
  it("expira documentos fora de prazo", async () => {
    const { doc } = await createDoc("simple", [{ name: "Paulo", email: "paulo@exemplo.pt" }]);
    await owner.from("documents").update({ expires_at: new Date(Date.now() + 2 * 3600_000).toISOString() }).eq("id", doc.id);
    await fn("document-actions", { action: "send", document_id: doc.id }, jwt);
    await admin.from("documents").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", doc.id);
    const res = await fetch(`${URL_}/functions/v1/reminders`, { method: "POST", headers: { "x-cron-secret": "dev-cron-secret-change-me", apikey: ANON } });
    const j = await res.json();
    expect(j.expired).toBeGreaterThanOrEqual(1);
    const { data } = await admin.from("documents").select("status").eq("id", doc.id).single();
    expect(data!.status).toBe("expired");
  });
});
