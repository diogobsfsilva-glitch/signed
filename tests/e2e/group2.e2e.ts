// Grupo 2: assinatura presencial e links públicos.
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

async function fn(name: string, body: unknown, jwt?: string, ip?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${jwt ?? ANON}` };
  if (ip) headers["x-forwarded-for"] = ip;
  const res = await fetch(`${URL_}/functions/v1/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
}
async function lastEmail(to: string, kind: string): Promise<string> {
  const { data } = await admin.from("email_log").select("body_text").eq("to_email", to).eq("kind", kind).order("id", { ascending: false }).limit(1);
  return data?.[0]?.body_text ?? "";
}
async function emailCount(to: string, kind: string): Promise<number> {
  const { count } = await admin.from("email_log").select("id", { count: "exact", head: true }).eq("to_email", to).eq("kind", kind);
  return count ?? 0;
}

let owner: SupabaseClient;
let jwt: string;
let ws: string;
let ownerId: string;

async function pdfPath(docId: string): Promise<string> {
  const p = await PDFDocument.create();
  p.addPage([595.28, 841.89]);
  const path = `${ws}/${docId}/original.pdf`;
  await owner.storage.from("documents").upload(path, await p.save(), { contentType: "application/pdf" });
  await owner.from("documents").update({ original_path: path, page_count: 1, pages: [{ w: 595.28, h: 841.89 }] }).eq("id", docId);
  return path;
}

beforeAll(async () => {
  await admin.auth.admin.createUser({ email: "diogo@altishotels.com", password: "Teste12345!", email_confirm: true, user_metadata: { full_name: "Diogo Silva" } }).catch(() => {});
  owner = createClient(URL_, ANON, { auth: { persistSession: false } });
  await owner.auth.signInWithPassword({ email: "diogo@altishotels.com", password: "Teste12345!" });
  jwt = (await owner.auth.getSession()).data.session!.access_token;
  ownerId = (await owner.auth.getUser()).data.user!.id;
  await admin.from("profiles").update({ role: "admin" }).eq("id", ownerId);
  ws = (await owner.from("workspaces").select("id").order("created_at").limit(1).single()).data!.id;
});

describe("assinatura presencial", () => {
  it("sem email nem código: o colaborador abre a sessão e o hóspede assina", async () => {
    const { data: doc } = await owner.from("documents").insert({ workspace_id: ws, owner_id: ownerId, title: `Check-in ${Date.now()}` }).select().single();
    await pdfPath(doc!.id);
    const guest = crypto.randomUUID();
    const staff = crypto.randomUUID();
    const staffEmail = `rececao.${Date.now()}@altishotels.com`;
    expect((await owner.from("recipients").insert([
      { id: guest, document_id: doc!.id, name: "Hóspede Smith", email: "", role: "signer", signing_order: 1, in_person: true },
      { id: staff, document_id: doc!.id, name: "Rececionista", email: staffEmail, role: "signer", signing_order: 2 },
    ], { defaultToNull: false })).error).toBeNull();
    await owner.from("fields").insert([
      { document_id: doc!.id, recipient_id: guest, type: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.08, value: null, readonly: false },
      { document_id: doc!.id, recipient_id: staff, type: "signature", page: 1, x: 0.55, y: 0.8, w: 0.3, h: 0.08, value: null, readonly: false },
    ]);
    expect((await fn("document-actions", { action: "send", document_id: doc!.id }, jwt)).ok).toBe(true);

    // Nenhum convite por email para o presencial; o 2.º ainda não foi notificado.
    expect(await emailCount(staffEmail, "invite")).toBe(0);
    const { data: ev0 } = await admin.from("audit_events").select("event").eq("document_id", doc!.id);
    expect(ev0!.map((e) => e.event)).toContain("recipient.awaiting_in_person");

    // Outro colaborador sem permissões não abre a sessão.
    await admin.auth.admin.createUser({ email: "intruso.g2@altishotels.com", password: "Teste12345!", email_confirm: true }).catch(() => {});
    const other = createClient(URL_, ANON, { auth: { persistSession: false } });
    await other.auth.signInWithPassword({ email: "intruso.g2@altishotels.com", password: "Teste12345!" });
    const otherJwt = (await other.auth.getSession()).data.session!.access_token;
    await admin.from("profiles").update({ role: "user" }).eq("email", "intruso.g2@altishotels.com");
    expect((await fn("document-actions", { action: "in_person", document_id: doc!.id, recipient_id: guest }, otherJwt)).status).toBe(403);
    // O 2.º signatário (não presencial) não pode ser aberto assim.
    expect((await fn("document-actions", { action: "in_person", document_id: doc!.id, recipient_id: staff }, jwt)).status).toBe(404);

    const s = await fn("document-actions", { action: "in_person", document_id: doc!.id, recipient_id: guest }, jwt);
    expect(s.token).toBeTruthy();
    // O link presencial não serve para pedir código por email.
    expect((await fn("signer-api", { action: "send-otp", token: s.token })).status).toBe(403);
    const l = await fn("signer-api", { action: "load", token: s.token, session: s.session });
    expect(l.step).toBe("sign_simple");
    const { data: sig } = await admin.from("fields").select("id").eq("recipient_id", guest).single();
    expect((await fn("signer-api", { action: "submit", token: s.token, session: s.session, values: { [sig!.id]: PNG } })).ok).toBe(true);

    // Agora o rececionista recebe o convite normal.
    expect(await emailCount(staffEmail, "invite")).toBe(1);
    const { data: ev } = await admin.from("audit_events").select("event, actor_user_id").eq("document_id", doc!.id).eq("event", "recipient.in_person_started");
    expect(ev![0].actor_user_id).toBe(ownerId);
  });

  it("não é permitido no modo Cartão de Cidadão", async () => {
    const { data: doc } = await owner.from("documents").insert({ workspace_id: ws, owner_id: ownerId, title: "CC presencial", signature_mode: "qualified" }).select().single();
    await pdfPath(doc!.id);
    const g = crypto.randomUUID();
    await owner.from("recipients").insert({ id: g, document_id: doc!.id, name: "Ana", email: "", role: "signer", signing_order: 1, in_person: true });
    await owner.from("fields").insert({ document_id: doc!.id, recipient_id: g, type: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.08 });
    const r = await fn("document-actions", { action: "send", document_id: doc!.id }, jwt);
    expect(r.status).toBe(422);
    expect(r.error).toMatch(/presencial só existe na assinatura simples/);
  });
});

describe("links públicos", () => {
  let templateId: string;
  let slug: string;
  let linkId: string;

  beforeAll(async () => {
    const { data: tpl } = await owner.from("documents").insert({ workspace_id: ws, owner_id: ownerId, title: "Termo do spa", is_template: true, message: "Leia com atenção." }).select().single();
    templateId = tpl!.id;
    await pdfPath(templateId);
    const guest = crypto.randomUUID();
    await owner.from("recipients").insert({ id: guest, document_id: templateId, name: "Hóspede", email: "", role: "signer", signing_order: 1 });
    await owner.from("fields").insert([
      { document_id: templateId, recipient_id: guest, type: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.08, value: null, readonly: false },
      { document_id: templateId, recipient_id: guest, type: "name", page: 1, x: 0.1, y: 0.7, w: 0.3, h: 0.03, value: null, readonly: false },
      { document_id: templateId, recipient_id: guest, type: "text", page: 1, x: 0.1, y: 0.6, w: 0.3, h: 0.03, label: "Serviço", value: "Spa Altis", readonly: true },
    ]);
    const { data: link, error } = await owner.from("public_links").insert({ workspace_id: ws, owner_id: ownerId, template_id: templateId, title: "Termo — Spa", max_uses: 3 }).select().single();
    expect(error).toBeNull();
    slug = link!.slug;
    linkId = link!.id;
    expect(slug).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("um documento normal não pode ser usado num link", async () => {
    const { data: doc } = await owner.from("documents").insert({ workspace_id: ws, owner_id: ownerId, title: "Não modelo" }).select().single();
    const r = await owner.from("public_links").insert({ workspace_id: ws, owner_id: ownerId, template_id: doc!.id, title: "x" });
    expect(r.error).toBeTruthy();
  });

  it("sem código: cria a cópia, envia e abre logo a sessão; assina", async () => {
    const info = await fn("public-form", { action: "info", slug });
    expect(info).toMatchObject({ title: "Termo — Spa", require_email_code: false, mode: "simple", message: "Leia com atenção." });
    expect((await fn("public-form", { action: "start", slug, name: "", email: "x" })).status).toBe(422);

    const r = await fn("public-form", { action: "start", slug, name: "Maria Hóspede", email: "Maria.H@exemplo.pt" });
    expect(r.token).toBeTruthy();
    expect(r.session).toBeTruthy();
    const l = await fn("signer-api", { action: "load", token: r.token, session: r.session });
    expect(l.step).toBe("sign_simple");
    expect(l.document.title).toBe("Termo — Spa — Maria Hóspede");
    const sig = l.fields.find((f: { type: string }) => f.type === "signature").id;
    expect((await fn("signer-api", { action: "submit", token: r.token, session: r.session, values: { [sig]: PNG } })).ok).toBe(true);

    const { data: doc } = await admin.from("documents").select("id, status, owner_id, public_link_id").eq("id", l.document.id).single();
    expect(doc).toMatchObject({ status: "completed", owner_id: ownerId, public_link_id: linkId });
    const { data: f } = await admin.from("fields").select("type, value").eq("document_id", doc!.id).in("type", ["name", "text"]);
    expect(f!.map((x) => x.value).sort()).toEqual(["Maria Hóspede", "Spa Altis"]);
    expect(await lastEmail("maria.h@exemplo.pt", "invite")).toContain("/s/"); // também recebeu o link
    // O modelo continua intacto e o contador subiu.
    expect((await admin.from("public_links").select("uses").eq("id", linkId).single()).data!.uses).toBe(1);
    // O dono vê a resposta.
    expect((await owner.from("documents").select("id").eq("public_link_id", linkId)).data).toHaveLength(1);
  });

  it("com código: devolve só o link e pede o código por email", async () => {
    await owner.from("public_links").update({ require_email_code: true }).eq("id", linkId);
    const r = await fn("public-form", { action: "start", slug, name: "João Código", email: "joao.cod@exemplo.pt" });
    expect(r.token).toBeTruthy();
    expect(r.session).toBeUndefined();
    expect((await fn("signer-api", { action: "send-otp", token: r.token })).ok).toBe(true);
  });

  it("limite de utilizações, desativar e limite por IP", async () => {
    await owner.from("public_links").update({ require_email_code: false }).eq("id", linkId);
    expect((await fn("public-form", { action: "start", slug, name: "Terceira", email: "t3@exemplo.pt" })).token).toBeTruthy();
    const full = await fn("public-form", { action: "start", slug, name: "Quarta", email: "t4@exemplo.pt" });
    expect(full.status).toBe(410);
    expect((await fn("public-form", { action: "info", slug })).status).toBe(410);

    await owner.from("public_links").update({ max_uses: null, active: false }).eq("id", linkId);
    expect((await fn("public-form", { action: "info", slug })).status).toBe(404);

    // Limite por link e IP: 60 por hora (link novo para o teste ser repetível).
    const { data: l2 } = await owner.from("public_links").insert({ workspace_id: ws, owner_id: ownerId, template_id: templateId, title: "Limite IP" }).select().single();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await fn("public-form", { action: "start", slug: l2!.slug, name: `Bot ${i}`, email: `bot${i}@exemplo.pt` })).status);
    expect(statuses.slice(0, 60).every((x) => x === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    // O limite é por link: o link principal continua a funcionar.
    await owner.from("public_links").update({ active: true }).eq("id", linkId);
    expect((await fn("public-form", { action: "start", slug, name: "Depois", email: "depois@exemplo.pt" })).token).toBeTruthy();
  });

  it("um link de outro espaço de trabalho ou anónimo não é visível", async () => {
    const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
    expect((await anon.from("public_links").select("id")).data ?? []).toHaveLength(0);
    expect((await anon.rpc("instantiate_public", { p_slug: slug, p_name: "x", p_email: "x@x.pt" })).error).toBeTruthy();
    expect((await owner.rpc("instantiate_public", { p_slug: slug, p_name: "x", p_email: "x@x.pt" })).error).toBeTruthy();
  });
});
