// Correções da revisão (lote A): código por email, assinatura inválida, cancelar, corrigir, links.
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import { execSync } from "node:child_process";

const status = JSON.parse(execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const URL_ = status.API_URL as string;
const ANON = status.ANON_KEY as string;
const admin = createClient(URL_, status.SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });

async function fn(name: string, body: unknown, jwt?: string) {
  const res = await fetch(`${URL_}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${jwt ?? ANON}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
}
async function lastEmail(to: string, kind: string): Promise<{ body: string; subject: string }> {
  const { data } = await admin.from("email_log").select("body_text, subject").eq("to_email", to).eq("kind", kind).order("id", { ascending: false }).limit(1);
  return { body: data?.[0]?.body_text ?? "", subject: data?.[0]?.subject ?? "" };
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

async function sentDoc(recipients: { name: string; email: string; in_person?: boolean }[], extra: Record<string, unknown> = {}) {
  const { data: doc } = await owner.from("documents").insert({ workspace_id: ws, owner_id: ownerId, title: `Doc ${Date.now()}`, ...extra }).select().single();
  const p = await PDFDocument.create();
  p.addPage([595.28, 841.89]);
  const path = `${ws}/${doc!.id}/original.pdf`;
  await owner.storage.from("documents").upload(path, await p.save(), { contentType: "application/pdf" });
  await owner.from("documents").update({ original_path: path, page_count: 1, pages: [{ w: 595.28, h: 841.89 }] }).eq("id", doc!.id);
  const ids: string[] = [];
  for (const [i, r] of recipients.entries()) {
    const id = crypto.randomUUID();
    ids.push(id);
    await owner.from("recipients").insert({ id, document_id: doc!.id, name: r.name, email: r.email, role: "signer", signing_order: i + 1, in_person: !!r.in_person });
    await owner.from("fields").insert({ document_id: doc!.id, recipient_id: id, type: "signature", page: 1, x: 0.1, y: 0.1 + i * 0.1, w: 0.3, h: 0.08 });
  }
  if (!extra.is_template) expect((await fn("document-actions", { action: "send", document_id: doc!.id }, jwt)).ok).toBe(true);
  return { id: doc!.id as string, ids };
}

describe("código de acesso por email", () => {
  it("pedidos em paralelo não ultrapassam as 5 tentativas, e o código não vai no assunto", async () => {
    const email = `par.${Date.now()}@exemplo.pt`;
    const { id } = await sentDoc([{ name: "Ana", email }]);
    const token = /\/s\/([A-Za-z0-9_-]+)/.exec((await lastEmail(email, "invite")).body)![1];
    expect((await fn("signer-api", { action: "send-otp", token })).ok).toBe(true);
    const otp = await lastEmail(email, "otp");
    const code = /^\s*(\d{6})\s*$/m.exec(otp.body)![1];
    expect(otp.subject).not.toContain(code);
    // 30 códigos errados ao mesmo tempo.
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    await Promise.all(Array.from({ length: 30 }, () => fn("signer-api", { action: "verify-otp", token, code: wrong })));
    const { count } = await admin.from("audit_events").select("id", { count: "exact", head: true }).eq("document_id", id).eq("event", "recipient.otp_failed");
    expect(count).toBeLessThanOrEqual(5);
    // Continuando com erros, um a um: no total nunca há mais de 5 comparações, e depois fica bloqueado.
    for (let i = 0; i < 6; i++) await fn("signer-api", { action: "verify-otp", token, code: wrong });
    const { count: total } = await admin.from("audit_events").select("id", { count: "exact", head: true }).eq("document_id", id).eq("event", "recipient.otp_failed");
    expect(total).toBe(5);
    const after = await fn("signer-api", { action: "verify-otp", token, code });
    expect(after.status).toBe(429);
    expect(after.code).toBe("otp_locked");
  });

  it("no máximo 5 códigos por hora para o mesmo destinatário", async () => {
    const email = `hora.${Date.now()}@exemplo.pt`;
    const { ids } = await sentDoc([{ name: "Rui", email }]);
    const token = /\/s\/([A-Za-z0-9_-]+)/.exec((await lastEmail(email, "invite")).body)![1];
    for (let i = 0; i < 5; i++) {
      expect((await fn("signer-api", { action: "send-otp", token })).ok).toBe(true);
      // Salta a espera de 1 minuto entre pedidos.
      await admin.from("signer_otps").update({ sent_at: new Date(Date.now() - 120_000).toISOString() }).eq("recipient_id", ids[0]);
    }
    const r = await fn("signer-api", { action: "send-otp", token });
    expect(r.status).toBe(429);
    expect(r.code).toBe("otp_hourly");
  });
});

async function session(email: string) {
  const token = /\/s\/([A-Za-z0-9_-]+)/.exec((await lastEmail(email, "invite")).body)![1];
  await fn("signer-api", { action: "send-otp", token });
  const code = /^\s*(\d{6})\s*$/m.exec((await lastEmail(email, "otp")).body)![1];
  const s = (await fn("signer-api", { action: "verify-otp", token, code })).session as string;
  const l = await fn("signer-api", { action: "load", token, session: s });
  return { token, session: s, fields: l.fields as { id: string }[] };
}

describe("assinar, cancelar e corrigir", () => {
  it("recusa uma imagem de assinatura que não é um PNG válido (o documento ficaria preso)", async () => {
    const email = `png.${Date.now()}@exemplo.pt`;
    const { id } = await sentDoc([{ name: "Eva", email }]);
    const s = await session(email);
    const r = await fn("signer-api", { action: "submit", token: s.token, session: s.session, values: { [s.fields[0].id]: "data:image/png;base64,AAAA" } });
    expect(r.status).toBe(422);
    expect(r.code).toBe("bad_signature");
    const { data: rec } = await admin.from("recipients").select("status").eq("document_id", id).single();
    expect(rec!.status).not.toBe("signed");
  });

  it("submeter duas vezes ao mesmo tempo grava uma só assinatura", async () => {
    const email = `dupla.${Date.now()}@exemplo.pt`;
    const { id } = await sentDoc([{ name: "Luís", email }]);
    const s = await session(email);
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const body = { action: "submit", token: s.token, session: s.session, values: { [s.fields[0].id]: PNG } };
    const res = await Promise.all([fn("signer-api", body), fn("signer-api", body)]);
    expect(res.filter((x) => x.ok).length).toBe(1);
    const { count } = await admin.from("audit_events").select("id", { count: "exact", head: true }).eq("document_id", id).eq("event", "recipient.signed");
    expect(count).toBe(1);
    expect((await admin.from("documents").select("status").eq("id", id).single()).data!.status).toBe("completed");
  });

  it("cancelar um documento já concluído é recusado", async () => {
    const email = `canc.${Date.now()}@exemplo.pt`;
    const { id } = await sentDoc([{ name: "Rita", email }]);
    expect((await fn("document-actions", { action: "cancel", document_id: id }, jwt)).ok).toBe(true);
    const again = await fn("document-actions", { action: "cancel", document_id: id }, jwt);
    expect(again.status).toBe(409);
  });

  it("corrigir o prazo com dois presenciais sem email funciona", async () => {
    const { id } = await sentDoc([{ name: "Hóspede 1", email: "", in_person: true }, { name: "Hóspede 2", email: "", in_person: true }], { sequential: false });
    const prazo = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const r = await fn("document-actions", { action: "correct", document_id: id, expires_at: prazo }, jwt);
    expect(r.ok).toBe(true);
    // Corrigir só o nome de um presencial também.
    const { data: recs } = await admin.from("recipients").select("id").eq("document_id", id).order("signing_order");
    const r2 = await fn("document-actions", { action: "correct", document_id: id, recipients: [{ id: recs![0].id, name: "John Smith" }] }, jwt);
    expect(r2.ok).toBe(true);
  });
});

describe("links públicos", () => {
  it("um link já usado pode ser apagado (os documentos ficam, sem a ligação ao link)", async () => {
    const tpl = await sentDoc([{ name: "Hóspede", email: "" }], { is_template: true });
    const { data: link } = await owner.from("public_links").insert({ workspace_id: ws, owner_id: ownerId, template_id: tpl.id, title: "Spa" }).select().single();
    const st = await fn("public-form", { action: "start", slug: link!.slug, name: "Maria", email: `maria.${Date.now()}@exemplo.pt` });
    expect(st.token).toBeTruthy();
    const { data: made } = await admin.from("documents").select("id, status").eq("public_link_id", link!.id).single();
    expect(made!.status).toBe("in_progress");
    const del = await owner.from("public_links").delete().eq("id", link!.id);
    expect(del.error).toBeNull();
    const { data: still } = await admin.from("documents").select("status, public_link_id").eq("id", made!.id).single();
    expect(still).toEqual({ status: "in_progress", public_link_id: null });
  });
});
