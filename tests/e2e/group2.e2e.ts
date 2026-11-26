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

describe("idiomas e marca do hotel", () => {
  it("convite e código no idioma do signatário, com a marca do espaço de trabalho", async () => {
    // Marca: só o administrador do espaço carrega o logótipo.
    const png = Uint8Array.from(atob(PNG.split(",")[1]), (c) => c.charCodeAt(0));
    const path = `${ws}/logo-${Date.now()}.png`;
    expect((await owner.storage.from("branding").upload(path, png, { contentType: "image/png" })).error).toBeNull();
    expect((await owner.from("workspaces").update({ brand_color: "#7a1f2b", logo_path: path }).eq("id", ws)).error).toBeNull();
    expect((await owner.from("workspaces").update({ logo_path: `${crypto.randomUUID()}/x.png` }).eq("id", ws)).error).toBeTruthy();
    await admin.auth.admin.createUser({ email: "membro.brand@altishotels.com", password: "Teste12345!", email_confirm: true }).catch(() => {});
    const member = createClient(URL_, ANON, { auth: { persistSession: false } });
    await member.auth.signInWithPassword({ email: "membro.brand@altishotels.com", password: "Teste12345!" });
    await admin.from("profiles").update({ role: "user" }).eq("email", "membro.brand@altishotels.com");
    expect((await member.storage.from("branding").upload(`${ws}/hack.png`, png, { contentType: "image/png" })).error).toBeTruthy();

    const { data: doc } = await owner.from("documents").insert({ workspace_id: ws, owner_id: ownerId, title: "Pool rules" }).select().single();
    await pdfPath(doc!.id);
    const g = crypto.randomUUID();
    const email = `john.${Date.now()}@example.com`;
    await owner.from("recipients").insert({ id: g, document_id: doc!.id, name: "John Smith", email, role: "signer", signing_order: 1, language: "en" });
    await owner.from("fields").insert({ document_id: doc!.id, recipient_id: g, type: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.08 });
    expect((await fn("document-actions", { action: "send", document_id: doc!.id }, jwt)).ok).toBe(true);
    const { data: inv } = await admin.from("email_log").select("subject").eq("to_email", email).eq("kind", "invite").single();
    expect(inv!.subject).toBe("Diogo Silva asks you to sign: Pool rules");
    const token = /\/s\/([A-Za-z0-9_-]+)/.exec(await lastEmail(email, "invite"))![1];
    const st = await fn("signer-api", { action: "start", token });
    expect(st.recipient.language).toBe("en");
    expect(st.brand).toMatchObject({ color: "#7a1f2b" });
    expect(st.brand.logoUrl).toContain(path);
    await fn("signer-api", { action: "send-otp", token });
    const { data: otp } = await admin.from("email_log").select("subject").eq("to_email", email).eq("kind", "otp").single();
    expect(otp!.subject).toMatch(/^Signed access code: Pool rules$/);
    await owner.from("workspaces").update({ brand_color: null, logo_path: null }).eq("id", ws);
  });

  it("formulário público: idioma escolhido passa para o convite", async () => {
    const { data: tpl } = await owner.from("documents").select("id").eq("title", "Termo do spa").eq("is_template", true).limit(1).single();
    const { data: link } = await owner.from("public_links").insert({ workspace_id: ws, owner_id: ownerId, template_id: tpl!.id, title: "Spa (ES)" }).select().single();
    const email = `ana.${Date.now()}@ejemplo.es`;
    const r = await fn("public-form", { action: "start", slug: link!.slug, name: "Ana García", email, language: "es" });
    expect(r.token).toBeTruthy();
    const { data: inv } = await admin.from("email_log").select("subject").eq("to_email", email).eq("kind", "invite").single();
    expect(inv!.subject).toMatch(/le pide firmar/);
  });
});

describe("grupos de assinatura", () => {
  it("todos recebem o convite; o membro escolhido recebe o código e fica registado como quem assinou", async () => {
    const stamp = Date.now();
    const members = [`fin1.${stamp}@altishotels.com`, `fin2.${stamp}@altishotels.com`, `fin3.${stamp}@altishotels.com`];
    const { data: doc } = await owner.from("documents").insert({ workspace_id: ws, owner_id: ownerId, title: `Fatura ${stamp}` }).select().single();
    await pdfPath(doc!.id);
    const g = crypto.randomUUID();
    expect((await owner.from("recipients").insert({ id: g, document_id: doc!.id, name: "Direção Financeira", email: "", role: "signer", signing_order: 1, group_emails: members })).error).toBeNull();
    await owner.from("fields").insert({ document_id: doc!.id, recipient_id: g, type: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.08 });
    expect((await fn("document-actions", { action: "send", document_id: doc!.id }, jwt)).ok).toBe(true);
    for (const m of members) expect(await emailCount(m, "invite")).toBe(1);

    const token = /\/s\/([A-Za-z0-9_-]+)/.exec(await lastEmail(members[0], "invite"))![1];
    const st = await fn("signer-api", { action: "start", token });
    expect(st.recipient.group).toHaveLength(3);
    expect(st.recipient.group[1]).toMatch(/^fi\*+@altishotels\.com$/);
    expect((await fn("signer-api", { action: "send-otp", token })).status).toBe(400);
    expect((await fn("signer-api", { action: "send-otp", token, member: 1 })).ok).toBe(true);
    expect(await emailCount(members[0], "otp")).toBe(0);
    const code = /^\s*(\d{6})\s*$/m.exec(await lastEmail(members[1], "otp"))![1];
    const v = await fn("signer-api", { action: "verify-otp", token, code });
    const l = await fn("signer-api", { action: "load", token, session: v.session });
    const sig = l.fields[0].id;
    expect((await fn("signer-api", { action: "submit", token, session: v.session, values: { [sig]: PNG } })).ok).toBe(true);
    const { data: r } = await admin.from("recipients").select("status, signed_by").eq("id", g).single();
    expect(r).toEqual({ status: "signed", signed_by: members[1] });
    // Cópia final só para quem assinou.
    expect(await emailCount(members[1], "completed")).toBe(1);
    expect(await emailCount(members[0], "completed")).toBe(0);
  });

  it("não é permitido no modo Cartão de Cidadão nem com um só email", async () => {
    const { data: doc } = await owner.from("documents").insert({ workspace_id: ws, owner_id: ownerId, title: "Grupo CC", signature_mode: "qualified" }).select().single();
    await pdfPath(doc!.id);
    const g = crypto.randomUUID();
    expect((await owner.from("recipients").insert({ id: g, document_id: doc!.id, name: "Grupo", email: "", role: "signer", signing_order: 1, group_emails: ["so@um.pt"] })).error).toBeTruthy();
    await owner.from("recipients").insert({ id: g, document_id: doc!.id, name: "Grupo", email: "", role: "signer", signing_order: 1, group_emails: ["a@x.pt", "b@x.pt"] });
    await owner.from("fields").insert({ document_id: doc!.id, recipient_id: g, type: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.08 });
    const r = await fn("document-actions", { action: "send", document_id: doc!.id }, jwt);
    expect(r.status).toBe(422);
    expect(r.error).toMatch(/grupos de assinatura só existem na assinatura simples/);
  });

  it("link público com o hotel (grupo) a contra-assinar", async () => {
    const stamp = Date.now();
    const { data: tpl } = await owner.from("documents").insert({ workspace_id: ws, owner_id: ownerId, title: `Autorização ${stamp}`, is_template: true }).select().single();
    await pdfPath(tpl!.id);
    const guest = crypto.randomUUID();
    const desk = crypto.randomUUID();
    await owner.from("recipients").insert([
      { id: guest, document_id: tpl!.id, name: "Hóspede", email: "", role: "signer", signing_order: 1, group_emails: null },
      { id: desk, document_id: tpl!.id, name: "Receção", email: "", role: "signer", signing_order: 2, group_emails: [`rec1.${stamp}@altishotels.com`, `rec2.${stamp}@altishotels.com`] },
    ], { defaultToNull: false });
    await owner.from("fields").insert([
      { document_id: tpl!.id, recipient_id: guest, type: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.08 },
      { document_id: tpl!.id, recipient_id: desk, type: "signature", page: 1, x: 0.55, y: 0.8, w: 0.3, h: 0.08 },
    ]);
    const { data: link } = await owner.from("public_links").insert({ workspace_id: ws, owner_id: ownerId, template_id: tpl!.id, title: "Autorização" }).select().single();
    const r = await fn("public-form", { action: "start", slug: link!.slug, name: "Pai Silva", email: `pai.${stamp}@exemplo.pt` });
    expect(r.session).toBeTruthy();
    const l = await fn("signer-api", { action: "load", token: r.token, session: r.session });
    expect((await fn("signer-api", { action: "submit", token: r.token, session: r.session, values: { [l.fields[0].id]: PNG } })).ok).toBe(true);
    // A receção (grupo) recebe agora o convite.
    expect(await emailCount(`rec1.${stamp}@altishotels.com`, "invite")).toBe(1);
    expect(await emailCount(`rec2.${stamp}@altishotels.com`, "invite")).toBe(1);
  });
});
