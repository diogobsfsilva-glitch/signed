// Lote D: fim de contrato, envio agendado, "para eu assinar", aviso ao remetente, duplicar.
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
const cron = () => fetch(`${URL_}/functions/v1/reminders`, { method: "POST", headers: { "x-cron-secret": "dev-cron-secret-change-me", apikey: ANON } }).then((r) => r.json());
async function emails(to: string, kind: string) {
  const { data } = await admin.from("email_log").select("subject, body_text").eq("to_email", to).eq("kind", kind).order("id");
  return data ?? [];
}
async function login(email: string, name: string) {
  await admin.auth.admin.createUser({ email, password: "Teste12345!", email_confirm: true, user_metadata: { full_name: name } }).catch(() => {});
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  await c.auth.signInWithPassword({ email, password: "Teste12345!" });
  return { c, jwt: (await c.auth.getSession()).data.session!.access_token, id: (await c.auth.getUser()).data.user!.id };
}

let owner: SupabaseClient;
let jwt: string;
let ownerId: string;
let ws: string;
const OWNER = "diogo@altishotels.com";

beforeAll(async () => {
  ({ c: owner, jwt, id: ownerId } = await login(OWNER, "Diogo Silva"));
  ws = (await owner.from("workspaces").select("id").order("created_at").limit(1).single()).data!.id;
});

async function draft(title: string, recipients: { name: string; email: string }[], extra: Record<string, unknown> = {}) {
  const { data: doc } = await owner.from("documents").insert({ workspace_id: ws, owner_id: ownerId, title, ...extra }).select().single();
  const p = await PDFDocument.create();
  p.addPage([595.28, 841.89]);
  const path = `${ws}/${doc!.id}/original.pdf`;
  await owner.storage.from("documents").upload(path, await p.save(), { contentType: "application/pdf" });
  await owner.from("documents").update({ original_path: path, page_count: 1, pages: [{ w: 595.28, h: 841.89 }] }).eq("id", doc!.id);
  const ids: string[] = [];
  for (const [i, r] of recipients.entries()) {
    const id = crypto.randomUUID();
    ids.push(id);
    await owner.from("recipients").insert({ id, document_id: doc!.id, name: r.name, email: r.email, role: "signer", signing_order: i + 1 });
    await owner.from("fields").insert({ document_id: doc!.id, recipient_id: id, type: "signature", page: 1, x: 0.1, y: 0.1 + i * 0.1, w: 0.3, h: 0.08 });
  }
  return { id: doc!.id as string, ids };
}

describe("colaborador que também assina", () => {
  it("vê o pedido em «Para eu assinar», assina sem código e o remetente é avisado", async () => {
    const ana = await login("ana.rh@altishotels.com", "Ana RH");
    const d = await draft(`Avaliação ${Date.now()}`, [{ name: "Ana RH", email: "ana.rh@altishotels.com" }, { name: "Diretor", email: `dir.${Date.now()}@exemplo.pt` }]);
    expect((await fn("document-actions", { action: "send", document_id: d.id }, jwt)).ok).toBe(true);

    const { data: reqs } = await ana.c.rpc("my_signature_requests");
    const mine = (reqs as { document_id: string; recipient_id: string; sender: string }[]).find((r) => r.document_id === d.id);
    expect(mine?.sender).toBe("Diogo Silva");
    // Outra pessoa não consegue abrir o pedido da Ana.
    const other = await login("outro.colab@altishotels.com", "Outro");
    expect((await fn("document-actions", { action: "sign-as-me", document_id: d.id, recipient_id: mine!.recipient_id }, other.jwt)).status).toBe(404);

    const s = await fn("document-actions", { action: "sign-as-me", document_id: d.id, recipient_id: mine!.recipient_id }, ana.jwt);
    expect(s.token && s.session).toBeTruthy();
    const l = await fn("signer-api", { action: "load", token: s.token, session: s.session });
    expect(l.step).toBe("sign_simple");
    expect((await fn("signer-api", { action: "submit", token: s.token, session: s.session, values: { [l.fields[0].id]: PNG } })).ok).toBe(true);

    const notes = await emails(OWNER, "owner_signed");
    expect(notes.some((n) => n.subject.startsWith("Ana RH assinou"))).toBe(true);
    const { data: ev } = await admin.from("audit_events").select("event").eq("document_id", d.id).eq("event", "recipient.authenticated_sso");
    expect(ev!.length).toBe(1);
    // Depois de assinar, já não aparece na lista.
    const { data: after } = await ana.c.rpc("my_signature_requests");
    expect((after as { document_id: string }[]).some((r) => r.document_id === d.id)).toBe(false);
  });
});

describe("envio agendado", () => {
  it("envia na hora; um rascunho incompleto não é enviado e o dono é avisado", async () => {
    const good = await draft(`Agendado ${Date.now()}`, [{ name: "Rui", email: `rui.${Date.now()}@exemplo.pt` }]);
    // A aplicação recusa datas no passado (ou a menos de 5 minutos).
    const tooSoon = await owner.from("documents").update({ scheduled_at: new Date(Date.now() + 60_000).toISOString() }).eq("id", good.id);
    expect(tooSoon.error).not.toBeNull();
    expect((await owner.from("documents").update({ scheduled_at: new Date(Date.now() + 3600_000).toISOString() }).eq("id", good.id)).error).toBeNull();
    const bad = await draft(`Agendado sem signatário ${Date.now()}`, []);
    await owner.from("documents").update({ scheduled_at: new Date(Date.now() + 3600_000).toISOString() }).eq("id", bad.id);
    // Simula a passagem do tempo.
    await admin.from("documents").update({ scheduled_at: new Date(Date.now() - 60_000).toISOString() }).in("id", [good.id, bad.id]);
    const stats = await cron();
    expect(stats.scheduled).toBeGreaterThanOrEqual(1);
    const { data: g } = await admin.from("documents").select("status, scheduled_at").eq("id", good.id).single();
    expect(g).toEqual({ status: "in_progress", scheduled_at: null });
    const { data: b } = await admin.from("documents").select("status, scheduled_at").eq("id", bad.id).single();
    expect(b).toEqual({ status: "draft", scheduled_at: null });
    expect((await emails(OWNER, "schedule_failed")).some((m) => m.subject.includes("Agendado sem signatário"))).toBe(true);
  });
});

describe("fim do contrato", () => {
  it("o dono define a data depois de assinado; o alerta sai uma vez e volta a armar se a data mudar", async () => {
    const email = `forn.${Date.now()}@exemplo.pt`;
    const d = await draft(`Contrato lavandaria ${Date.now()}`, [{ name: "Fornecedor", email }], { notify_owner: false });
    expect((await fn("document-actions", { action: "send", document_id: d.id }, jwt)).ok).toBe(true);
    await admin.from("recipients").update({ status: "signed", signed_at: new Date().toISOString() }).eq("id", d.ids[0]);
    await admin.from("fields").update({ value: PNG }).eq("recipient_id", d.ids[0]);
    await admin.from("documents").update({ processing_lock: null }).eq("id", d.id);
    await cron(); // retoma e conclui
    expect((await admin.from("documents").select("status").eq("id", d.id).single()).data!.status).toBe("completed");

    const end = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    expect((await owner.from("documents").update({ contract_end: end, renewal_notice_days: 30 }).eq("id", d.id)).error).toBeNull();
    // Outras colunas continuam fechadas depois de enviado.
    expect((await owner.from("documents").update({ message: "x" }).eq("id", d.id)).error).not.toBeNull();

    await cron();
    await cron();
    const alerts = (await emails(OWNER, "renewal")).filter((m) => m.subject.includes("Contrato lavandaria"));
    expect(alerts.length).toBe(1);
    expect(alerts[0].body_text).toMatch(/daqui a 10 dias/);
    // Mudar a data volta a armar o alerta.
    await owner.from("documents").update({ contract_end: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) }).eq("id", d.id);
    expect((await admin.from("documents").select("renewal_notified_at").eq("id", d.id).single()).data!.renewal_notified_at).toBeNull();
    await cron();
    expect((await emails(OWNER, "renewal")).filter((m) => m.subject.includes("Contrato lavandaria")).length).toBe(2);
    // Com notify_owner desligado, não houve aviso de assinatura.
    expect((await admin.from("email_log").select("id").eq("document_id", d.id).eq("kind", "owner_signed")).data!.length).toBe(0);
  });
});

describe("duplicar", () => {
  it("o dono duplica um documento enviado; outra pessoa não", async () => {
    const d = await draft(`Para duplicar ${Date.now()}`, [{ name: "Eva", email: `eva.${Date.now()}@exemplo.pt` }], { contract_end: "2030-01-01", renewal_notice_days: 60 });
    expect((await fn("document-actions", { action: "send", document_id: d.id }, jwt)).ok).toBe(true);
    const { data, error } = await owner.rpc("instantiate_document", { p_source: d.id, p_as_template: false, p_title: "Cópia" });
    expect(error).toBeNull();
    const id = (Array.isArray(data) ? data[0] : data).new_document_id;
    const { data: copy } = await owner.from("documents").select("status, title, contract_end, renewal_notice_days, recipients(name)").eq("id", id).single();
    expect(copy).toMatchObject({ status: "draft", title: "Cópia", contract_end: null, renewal_notice_days: 60 });
    expect((copy!.recipients as { name: string }[]).map((r) => r.name)).toEqual(["Eva"]);
    const { data: ev } = await admin.from("audit_events").select("event").eq("document_id", id);
    expect(ev!.map((e) => e.event)).toContain("document.duplicated");
    const other = await login("outro.colab@altishotels.com", "Outro");
    const { error: e2 } = await other.c.rpc("instantiate_document", { p_source: d.id, p_as_template: false });
    expect(e2).not.toBeNull();
  });
});
