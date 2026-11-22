// Grupo 1: campos automáticos e pré-preenchidos, anexos, corrigir e delegar.
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import { execSync } from "node:child_process";

const status = JSON.parse(execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const URL_ = status.API_URL as string;
const ANON = status.ANON_KEY as string;
const admin = createClient(URL_, status.SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });
const anonClient = createClient(URL_, ANON, { auth: { persistSession: false } });
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
async function tokenFor(email: string): Promise<string> {
  const m = /\/s\/([A-Za-z0-9_-]+)/.exec(await lastEmail(email, "invite"));
  if (!m) throw new Error(`Sem convite para ${email}`);
  return m[1];
}
async function login(token: string, email: string): Promise<string> {
  expect((await fn("signer-api", { action: "send-otp", token })).ok).toBe(true);
  const code = /^\s*(\d{6})\s*$/m.exec(await lastEmail(email, "otp"))![1];
  const v = await fn("signer-api", { action: "verify-otp", token, code });
  expect(v.session).toBeTruthy();
  return v.session;
}
const todayLisbon = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date());

let owner: SupabaseClient;
let jwt: string;
let ws: string;
let ownerId: string;

type FieldSpec = { type: string; label?: string; value?: string; readonly?: boolean; required?: boolean; who?: number };
async function createDoc(recipients: { name: string; email: string }[], fields: FieldSpec[], opts: { mode?: "simple" | "qualified" } = {}) {
  const { data: doc, error } = await owner
    .from("documents")
    .insert({ workspace_id: ws, owner_id: ownerId, title: `G1 ${Date.now()}`, signature_mode: opts.mode ?? "simple", sequential: true })
    .select()
    .single();
  if (error) throw error;
  const p = await PDFDocument.create();
  p.addPage([595.28, 841.89]);
  const path = `${ws}/${doc.id}/original.pdf`;
  await owner.storage.from("documents").upload(path, await p.save(), { contentType: "application/pdf" });
  await owner.from("documents").update({ original_path: path, page_count: 1, pages: [{ w: 595.28, h: 841.89 }] }).eq("id", doc.id);
  const rows = recipients.map((r, i) => ({ id: crypto.randomUUID(), document_id: doc.id, name: r.name, email: r.email, role: "signer", signing_order: i + 1 }));
  expect((await owner.from("recipients").insert(rows)).error).toBeNull();
  const frows = fields.map((f, i) => ({
    id: crypto.randomUUID(), document_id: doc.id, recipient_id: rows[f.who ?? 0].id, type: f.type, page: 1,
    x: 0.05, y: 0.05 + i * 0.06, w: 0.3, h: 0.04, label: f.label ?? null, value: f.value ?? null, readonly: f.readonly ?? false,
    required: f.required ?? (f.type !== "checkbox"),
  }));
  const fr = await owner.from("fields").insert(frows);
  if (fr.error) throw fr.error;
  return { doc, rows, frows };
}

beforeAll(async () => {
  await admin.auth.admin.createUser({ email: "diogo@altishotels.com", password: "Teste12345!", email_confirm: true, user_metadata: { full_name: "Diogo Silva" } }).catch(() => {});
  owner = createClient(URL_, ANON, { auth: { persistSession: false } });
  await owner.auth.signInWithPassword({ email: "diogo@altishotels.com", password: "Teste12345!" });
  jwt = (await owner.auth.getSession()).data.session!.access_token;
  ownerId = (await owner.auth.getUser()).data.user!.id;
  await admin.from("profiles").update({ role: "admin" }).eq("id", ownerId);
  const { data } = await owner.from("workspaces").select("id").order("created_at").limit(1).single();
  ws = data!.id;
});

describe("campos automáticos e pré-preenchidos", () => {
  it("o remetente não pode pré-preencher uma assinatura", async () => {
    const { doc, rows } = await createDoc([{ name: "Ana", email: "ana.g1@exemplo.pt" }], [{ type: "signature" }]);
    const bad = await owner.from("fields").insert({ document_id: doc.id, recipient_id: rows[0].id, type: "signature", page: 1, x: 0.5, y: 0.5, w: 0.2, h: 0.05, value: PNG });
    expect(bad.error?.message).toMatch(/não pode ser pré-preenchido/);
  });

  it("campo fixo sem valor impede o envio", async () => {
    const { doc } = await createDoc([{ name: "Ana", email: "ana.g1b@exemplo.pt" }], [{ type: "signature" }, { type: "text", label: "Hotel", readonly: true }]);
    const r = await fn("document-actions", { action: "send", document_id: doc.id }, jwt);
    expect(r.status).toBe(422);
    expect(r.error).toMatch(/fixo "Hotel" não tem valor/);
  });

  it("nome, email e data ficam automáticos; o fixo não muda; o pré-preenchido editável pode mudar", async () => {
    const email = "joana.g1@exemplo.pt";
    const { doc, frows } = await createDoc([{ name: "Joana Reis", email }], [
      { type: "signature" },
      { type: "name" },
      { type: "email" },
      { type: "signed_date" },
      { type: "text", label: "Hotel", value: "Altis Grand", readonly: true },
      { type: "text", label: "Cargo", value: "Rececionista" },
    ]);
    expect((await fn("document-actions", { action: "send", document_id: doc.id }, jwt)).ok).toBe(true);
    const t = await tokenFor(email);
    const s = await login(t, email);
    const l = await fn("signer-api", { action: "load", token: t, session: s });
    const byType = (ty: string, label?: string) => l.fields.find((f: { type: string; label: string | null }) => f.type === ty && (!label || f.label === label));
    expect(byType("name").editable).toBe(false);
    expect(byType("signed_date").editable).toBe(false);
    expect(byType("text", "Hotel")).toMatchObject({ editable: false, readonly: true, value: "Altis Grand" });
    expect(byType("text", "Cargo")).toMatchObject({ editable: true, value: "Rececionista" });

    const sig = frows[0].id;
    const cargo = frows[5].id;
    const hotel = frows[4].id;
    // Tentar mudar o fixo é ignorado; mudar o editável é aceite.
    const sub = await fn("signer-api", { action: "submit", token: t, session: s, values: { [sig]: PNG, [cargo]: "Chefe de receção", [hotel]: "Outro" } });
    expect(sub.ok).toBe(true);
    const { data: f } = await admin.from("fields").select("type, label, value").eq("document_id", doc.id);
    const v = (ty: string, label?: string) => f!.find((x) => x.type === ty && (!label || x.label === label))!.value;
    expect(v("name")).toBe("Joana Reis");
    expect(v("email")).toBe(email);
    expect(v("signed_date")).toBe(todayLisbon());
    expect(v("text", "Hotel")).toBe("Altis Grand");
    expect(v("text", "Cargo")).toBe("Chefe de receção");
    const { data: d } = await admin.from("documents").select("status").eq("id", doc.id).single();
    expect(d!.status).toBe("completed");
  });

  it("modo CC: quem só tem campos automáticos não passa pela fase de preenchimento", async () => {
    const email = "rui.g1@exemplo.pt";
    const { doc } = await createDoc([{ name: "Rui Sousa", email }], [{ type: "signature" }, { type: "name" }, { type: "signed_date" }], { mode: "qualified" });
    expect((await fn("document-actions", { action: "send", document_id: doc.id }, jwt)).ok).toBe(true);
    const { data: d } = await admin.from("documents").select("phase, prepared_path").eq("id", doc.id).single();
    expect(d).toMatchObject({ phase: "sign" });
    expect(d!.prepared_path).toBeTruthy();
    const { data: f } = await admin.from("fields").select("type, value").eq("document_id", doc.id).eq("type", "name").single();
    expect(f!.value).toBe("Rui Sousa");
  });
});

describe("anexos do signatário", () => {
  it("carrega um PDF, valida o tipo e guarda o hash", async () => {
    const email = "carla.g1@exemplo.pt";
    const { doc, frows } = await createDoc([{ name: "Carla", email }], [{ type: "signature" }, { type: "attachment", label: "Cópia do CC" }]);
    expect((await fn("document-actions", { action: "send", document_id: doc.id }, jwt)).ok).toBe(true);
    const t = await tokenFor(email);
    const s = await login(t, email);
    const att = frows[1].id;

    // Extensão não permitida
    const badExt = await fn("signer-api", { action: "attachment-upload-url", token: t, session: s, field_id: att, file_name: "virus.exe" });
    expect(badExt.status).toBe(422);
    // Conteúdo que não é PDF nem imagem
    const u1 = await fn("signer-api", { action: "attachment-upload-url", token: t, session: s, field_id: att, file_name: "falso.pdf" });
    await anonClient.storage.from("documents").uploadToSignedUrl(u1.path, u1.uploadToken, new TextEncoder().encode("não sou um pdf"), { contentType: "application/pdf" });
    const sub1 = await fn("signer-api", { action: "submit", token: t, session: s, values: { [frows[0].id]: PNG, [att]: u1.path } });
    expect(sub1.status).toBe(422);
    // Caminho de outro documento
    const sub2 = await fn("signer-api", { action: "submit", token: t, session: s, values: { [frows[0].id]: PNG, [att]: `${ws}/${crypto.randomUUID()}/attachments/x.pdf` } });
    expect(sub2.status).toBe(400);

    const p = await PDFDocument.create();
    p.addPage();
    const bytes = await p.save();
    const u = await fn("signer-api", { action: "attachment-upload-url", token: t, session: s, field_id: att, file_name: "Cartão Cidadão.pdf" });
    expect(u.path).toMatch(/attachments\/.+-Cartao_Cidadao\.pdf$/);
    expect((await anonClient.storage.from("documents").uploadToSignedUrl(u.path, u.uploadToken, bytes, { contentType: "application/pdf" })).error).toBeNull();
    const sub = await fn("signer-api", { action: "submit", token: t, session: s, values: { [frows[0].id]: PNG, [att]: u.path } });
    expect(sub.ok).toBe(true);

    const { data: f } = await admin.from("fields").select("value").eq("id", att).single();
    const a = JSON.parse(f!.value);
    expect(a).toMatchObject({ path: u.path, name: "Cartao_Cidadao.pdf", type: "application/pdf", size: bytes.length });
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    // O remetente consegue descarregar o anexo.
    expect((await owner.storage.from("documents").download(u.path)).error).toBeNull();
    const { data: ev } = await admin.from("audit_events").select("event").eq("document_id", doc.id);
    expect(ev!.map((e) => e.event)).toContain("recipient.attachment_added");
    const { data: d } = await admin.from("documents").select("status, audit_path").eq("id", doc.id).single();
    expect(d!.status).toBe("completed");
  });
});

describe("corrigir documento enviado", () => {
  it("muda o email: o link antigo deixa de funcionar e o novo recebe o convite", async () => {
    const { doc, rows } = await createDoc(
      [{ name: "Pedro Erro", email: "pedro.errado@exemplo.pt" }, { name: "Marta", email: "marta.g1@exemplo.pt" }],
      [{ type: "signature", who: 0 }, { type: "signature", who: 1 }],
    );
    expect((await fn("document-actions", { action: "send", document_id: doc.id }, jwt)).ok).toBe(true);
    const oldToken = await tokenFor("pedro.errado@exemplo.pt");

    const other = await fn("document-actions", { action: "correct", document_id: doc.id, recipients: [{ id: rows[0].id, name: "Pedro Certo", email: "marta.g1@exemplo.pt" }] }, jwt);
    expect(other.status).toBe(422); // email repetido

    const c = await fn("document-actions", {
      action: "correct", document_id: doc.id,
      recipients: [{ id: rows[0].id, name: "Pedro Certo", email: "Pedro.Certo@exemplo.pt" }],
      expires_at: new Date(Date.now() + 5 * 86400_000).toISOString(),
    }, jwt);
    expect(c.ok).toBe(true);
    expect((await fn("signer-api", { action: "start", token: oldToken })).status).toBe(404);
    const newToken = await tokenFor("pedro.certo@exemplo.pt");
    expect(newToken).not.toBe(oldToken);
    const st = await fn("signer-api", { action: "start", token: newToken });
    expect(st.recipient.name).toBe("Pedro Certo");

    const s = await login(newToken, "pedro.certo@exemplo.pt");
    expect((await fn("signer-api", { action: "submit", token: newToken, session: s, values: { [(await admin.from("fields").select("id").eq("recipient_id", rows[0].id).single()).data!.id]: PNG } })).ok).toBe(true);
    // Quem já assinou não pode ser corrigido.
    const late = await fn("document-actions", { action: "correct", document_id: doc.id, recipients: [{ id: rows[0].id, name: "Outro", email: "outro@exemplo.pt" }] }, jwt);
    expect(late.status).toBe(409);

    const { data: ev } = await admin.from("audit_events").select("event, details").eq("document_id", doc.id).eq("event", "document.corrected");
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev![0].details)).toContain("pedro.errado@exemplo.pt");
  });
});

describe("delegar assinatura", () => {
  it("o signatário passa a assinatura a outra pessoa, que assina", async () => {
    const { doc, rows } = await createDoc([{ name: "Diretor Férias", email: "diretor.g1@exemplo.pt" }], [{ type: "signature" }, { type: "name" }]);
    expect((await fn("document-actions", { action: "send", document_id: doc.id }, jwt)).ok).toBe(true);
    const t = await tokenFor("diretor.g1@exemplo.pt");
    const s = await login(t, "diretor.g1@exemplo.pt");
    const same = await fn("signer-api", { action: "delegate", token: t, session: s, name: "X", email: "diretor.g1@exemplo.pt" });
    expect(same.status).toBe(422);
    const d = await fn("signer-api", { action: "delegate", token: t, session: s, name: "Subdiretor Silva", email: "sub.g1@exemplo.pt", reason: "Estou de férias" });
    expect(d.ok).toBe(true);
    expect((await fn("signer-api", { action: "load", token: t, session: s })).status).toBe(404);
    expect(await lastEmail("diogo@altishotels.com", "delegated")).toContain("Subdiretor Silva");

    const t2 = await tokenFor("sub.g1@exemplo.pt");
    const s2 = await login(t2, "sub.g1@exemplo.pt");
    const { data: sig } = await admin.from("fields").select("id").eq("recipient_id", rows[0].id).eq("type", "signature").single();
    expect((await fn("signer-api", { action: "submit", token: t2, session: s2, values: { [sig!.id]: PNG } })).ok).toBe(true);
    const { data: nm } = await admin.from("fields").select("value").eq("recipient_id", rows[0].id).eq("type", "name").single();
    expect(nm!.value).toBe("Subdiretor Silva");
    const { data: ev } = await admin.from("audit_events").select("event").eq("document_id", doc.id);
    expect(ev!.map((e) => e.event)).toEqual(expect.arrayContaining(["recipient.delegated", "document.completed"]));
  });
});

describe("envio em massa", () => {
  it("cria documentos de um modelo num lote, com valores do CSV, e envia-os", async () => {
    // Modelo: Colaborador (variável) + Diretor (fixo), com «Vencimento» pré-preenchível e «Hotel» fixo.
    const { data: tpl } = await owner
      .from("documents")
      .insert({ workspace_id: ws, owner_id: ownerId, title: "Contrato de época", is_template: true })
      .select()
      .single();
    const p = await PDFDocument.create();
    p.addPage();
    const path = `${ws}/${tpl!.id}/original.pdf`;
    await owner.storage.from("documents").upload(path, await p.save(), { contentType: "application/pdf" });
    await owner.from("documents").update({ original_path: path, page_count: 1, pages: [{ w: 595.28, h: 841.89 }] }).eq("id", tpl!.id);
    const colab = crypto.randomUUID();
    const dir = crypto.randomUUID();
    await owner.from("recipients").insert([
      { id: colab, document_id: tpl!.id, name: "Colaborador", email: "", role: "signer", signing_order: 1 },
      { id: dir, document_id: tpl!.id, name: "Diretor", email: "diretor.lote@altishotels.com", role: "signer", signing_order: 2 },
    ]);
    const fr = await owner.from("fields").insert([
      { document_id: tpl!.id, recipient_id: colab, type: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.08 },
      { document_id: tpl!.id, recipient_id: colab, type: "text", page: 1, x: 0.1, y: 0.6, w: 0.3, h: 0.03, label: "Vencimento", readonly: true, value: "0" },
      { document_id: tpl!.id, recipient_id: colab, type: "text", page: 1, x: 0.1, y: 0.5, w: 0.3, h: 0.03, label: "Hotel", readonly: true, value: "Altis Belém" },
      { document_id: tpl!.id, recipient_id: dir, type: "signature", page: 1, x: 0.55, y: 0.8, w: 0.3, h: 0.08 },
    ], { defaultToNull: false });
    expect(fr.error).toBeNull();

    const { data: batch, error: be } = await owner.from("batches").insert({ workspace_id: ws, owner_id: ownerId, template_id: tpl!.id, title: "Época 2027", total: 2 }).select().single();
    expect(be).toBeNull();
    const people = [
      { name: "Ana Lote", email: "ana.lote@exemplo.pt", venc: "1000" },
      { name: "Bruno Lote", email: "bruno.lote@exemplo.pt", venc: "1200" },
    ];
    for (const person of people) {
      const { data, error } = await owner.rpc("instantiate_document", {
        p_source: tpl!.id, p_as_template: false, p_title: `Contrato — ${person.name}`,
        p_recipients: [{ id: colab, name: person.name, email: person.email }], p_batch: batch!.id,
      });
      expect(error).toBeNull();
      const docId = data[0].new_document_id;
      expect((await owner.storage.from("documents").copy(path, data[0].new_original_path)).error).toBeNull();
      expect((await owner.from("fields").update({ value: person.venc }).eq("document_id", docId).eq("label", "Vencimento")).error).toBeNull();
      expect((await fn("document-actions", { action: "send", document_id: docId }, jwt)).ok).toBe(true);
    }
    const { data: docs } = await owner.from("documents").select("id, title, status, batch_id").eq("batch_id", batch!.id).order("title");
    expect(docs!.map((d) => [d.title, d.status])).toEqual([["Contrato — Ana Lote", "in_progress"], ["Contrato — Bruno Lote", "in_progress"]]);
    const { data: f } = await admin.from("fields").select("label, value, readonly, document_id").in("document_id", docs!.map((d) => d.id)).eq("label", "Hotel");
    expect(f!.every((x) => x.value === "Altis Belém" && x.readonly)).toBe(true);
    const { data: v } = await admin.from("fields").select("value").eq("document_id", docs![1].id).eq("label", "Vencimento").single();
    expect(v!.value).toBe("1200");
    // Cada pessoa recebeu o seu convite.
    expect(await tokenFor("ana.lote@exemplo.pt")).toBeTruthy();
    expect(await tokenFor("bruno.lote@exemplo.pt")).toBeTruthy();

    // Um lote alheio não pode ser usado.
    await admin.auth.admin.createUser({ email: "rita.lote@altishotels.com", password: "Teste12345!", email_confirm: true }).catch(() => {});
    const rita = createClient(URL_, ANON, { auth: { persistSession: false } });
    await rita.auth.signInWithPassword({ email: "rita.lote@altishotels.com", password: "Teste12345!" });
    const steal = await rita.rpc("instantiate_document", { p_source: tpl!.id, p_as_template: false, p_batch: batch!.id });
    expect(steal.error?.message).toMatch(/Lote inválido/);
    expect((await rita.from("batches").select("id").eq("id", batch!.id)).data).toHaveLength(0);
  });
});
