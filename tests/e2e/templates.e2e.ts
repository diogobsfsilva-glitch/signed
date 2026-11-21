// Modelos (Fase 2): criar, partilhar no espaço de trabalho, usar e guardar como modelo.
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import { execSync } from "node:child_process";

const status = JSON.parse(execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const URL_ = status.API_URL as string;
const ANON = status.ANON_KEY as string;
const SERVICE = status.SERVICE_ROLE_KEY as string;
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });

async function ensureUser(email: string, name: string): Promise<SupabaseClient> {
  await admin.auth.admin.createUser({ email, password: "Teste12345!", email_confirm: true, user_metadata: { full_name: name } }).catch(() => {});
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: "Teste12345!" });
  if (error) throw error;
  return c;
}

async function fn(name: string, body: unknown, jwt: string) {
  const res = await fetch(`${URL_}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
}

async function pdfBytes(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([595.28, 841.89]);
  return d.save({ useObjectStreams: false });
}

let owner: SupabaseClient;
let member: SupabaseClient;
let ws: string;
let ownerId: string;
let memberId: string;

/** Cria um documento (ou modelo) com 2 papéis e 3 campos. */
async function create(c: SupabaseClient, uid: string, isTemplate: boolean, emails: [string, string]) {
  const { data: doc, error } = await c
    .from("documents")
    .insert({ workspace_id: ws, owner_id: uid, title: `${isTemplate ? "Modelo" : "Doc"} ${Date.now()}`, is_template: isTemplate, message: "Assine, por favor." })
    .select()
    .single();
  if (error) throw error;
  const path = `${ws}/${doc.id}/original.pdf`;
  expect((await c.storage.from("documents").upload(path, await pdfBytes(), { contentType: "application/pdf" })).error).toBeNull();
  expect((await c.from("documents").update({ original_path: path, page_count: 1, pages: [{ w: 595.28, h: 841.89 }] }).eq("id", doc.id)).error).toBeNull();
  const rows = [
    { id: crypto.randomUUID(), document_id: doc.id, name: "Colaborador", email: emails[0], role: "signer", signing_order: 1 },
    { id: crypto.randomUUID(), document_id: doc.id, name: "Diretor do hotel", email: emails[1], role: "signer", signing_order: 2 },
  ];
  expect((await c.from("recipients").insert(rows)).error).toBeNull();
  const fr = await c.from("fields").insert([
    { document_id: doc.id, recipient_id: rows[0].id, type: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.08 },
    { document_id: doc.id, recipient_id: rows[0].id, type: "text", page: 1, x: 0.1, y: 0.7, w: 0.3, h: 0.03, label: "NIF" },
    { document_id: doc.id, recipient_id: rows[1].id, type: "signature", page: 1, x: 0.55, y: 0.8, w: 0.3, h: 0.08 },
  ]);
  expect(fr.error).toBeNull();
  return { doc, rows, path };
}

async function instantiate(c: SupabaseClient, args: Record<string, unknown>, sourcePath: string) {
  const { data, error } = await c.rpc("instantiate_document", args);
  if (error) return { error };
  const row = data[0] as { new_document_id: string; new_original_path: string };
  const cp = await c.storage.from("documents").copy(sourcePath, row.new_original_path);
  return { row, copyError: cp.error };
}

beforeAll(async () => {
  owner = await ensureUser("diogo@altishotels.com", "Diogo Silva");
  member = await ensureUser("rita@altishotels.com", "Rita Matos");
  ownerId = (await owner.auth.getUser()).data.user!.id;
  memberId = (await member.auth.getUser()).data.user!.id;
  // O primeiro utilizador é administrador; garantir que a Rita é só membro.
  await admin.from("profiles").update({ role: "user" }).eq("id", memberId);
  const { data } = await owner.from("workspaces").select("id").order("created_at").limit(1).single();
  ws = data!.id;
  await admin.from("workspace_members").upsert({ workspace_id: ws, user_id: memberId, role: "member" });
});

describe("modelos", () => {
  it("membro do espaço vê e usa o modelo, mas não o altera", async () => {
    const t = await create(owner, ownerId, true, ["", "diretor@altishotels.com"]);

    const { data: seen } = await member.from("documents").select("id, is_template").eq("id", t.doc.id);
    expect(seen).toHaveLength(1);
    const { data: upd } = await member.from("documents").update({ title: "alterado" }).eq("id", t.doc.id).select();
    expect(upd ?? []).toHaveLength(0);
    const { data: del } = await member.from("fields").delete().eq("document_id", t.doc.id).select();
    expect(del ?? []).toHaveLength(0);

    const r = await instantiate(
      member,
      {
        p_source: t.doc.id,
        p_as_template: false,
        p_title: "Contrato — Joana Reis",
        p_recipients: [{ id: t.rows[0].id, name: "Joana Reis", email: "Joana.Reis@Exemplo.pt" }],
      },
      t.path,
    );
    expect(r.error).toBeUndefined();
    expect(r.copyError).toBeNull();
    const id = r.row!.new_document_id;

    const { data: doc } = await member.from("documents").select("*").eq("id", id).single();
    expect(doc.owner_id).toBe(memberId);
    expect(doc.is_template).toBe(false);
    expect(doc.status).toBe("draft");
    expect(doc.title).toBe("Contrato — Joana Reis");
    expect(doc.message).toBe("Assine, por favor.");
    expect(doc.original_path).toBe(`${ws}/${id}/original.pdf`);

    const { data: recs } = await member.from("recipients").select("id, name, email, signing_order").eq("document_id", id).order("signing_order");
    expect(recs!.map((x) => [x.name, x.email])).toEqual([
      ["Joana Reis", "joana.reis@exemplo.pt"],
      ["Diretor do hotel", "diretor@altishotels.com"],
    ]);
    const { data: fields } = await member.from("fields").select("recipient_id, type, label").eq("document_id", id);
    expect(fields).toHaveLength(3);
    const ids = new Set(recs!.map((x) => x.id));
    expect(fields!.every((f) => ids.has(f.recipient_id))).toBe(true);
    expect(fields!.find((f) => f.type === "text")!.recipient_id).toBe(recs![0].id);

    const dl = await member.storage.from("documents").download(doc.original_path);
    expect(dl.error).toBeNull();

    const { data: ev } = await member.from("audit_events").select("event").eq("document_id", id).order("id");
    expect(ev!.map((e) => e.event)).toEqual(["document.created", "document.created_from_template"]);

    // O modelo continua intacto.
    const { data: tr } = await owner.from("recipients").select("email").eq("document_id", t.doc.id).order("signing_order");
    expect(tr!.map((x) => x.email)).toEqual(["", "diretor@altishotels.com"]);

    // O documento criado envia normalmente.
    const jwt = (await member.auth.getSession()).data.session!.access_token;
    const sent = await fn("document-actions", { action: "send", document_id: id }, jwt);
    expect(sent.status).toBe(200);
  });

  it("um modelo nunca é enviado", async () => {
    const t = await create(owner, ownerId, true, ["a@altishotels.com", "b@altishotels.com"]);
    const jwt = (await owner.auth.getSession()).data.session!.access_token;
    const r = await fn("document-actions", { action: "send", document_id: t.doc.id }, jwt);
    expect(r.status).toBe(422);
    expect(r.error).toMatch(/modelo/i);
    const { error } = await admin.from("documents").update({ status: "in_progress" }).eq("id", t.doc.id);
    expect(error?.message).toMatch(/modelo/i);
    const { error: e2 } = await admin.from("documents").update({ is_template: false }).eq("id", t.doc.id);
    expect(e2).toBeTruthy();
  });

  it("documento com email em falta não é enviado", async () => {
    const t = await create(owner, ownerId, true, ["", "b@altishotels.com"]);
    const r = await instantiate(owner, { p_source: t.doc.id, p_as_template: false }, t.path);
    const jwt = (await owner.auth.getSession()).data.session!.access_token;
    const s = await fn("document-actions", { action: "send", document_id: r.row!.new_document_id }, jwt);
    expect(s.status).toBe(422);
    expect(s.error).toMatch(/Falta o email de Colaborador/);
  });

  it("guardar como modelo e regras de acesso", async () => {
    const d = await create(owner, ownerId, false, ["x@exemplo.pt", "y@exemplo.pt"]);
    // Um documento normal não serve de modelo.
    const bad = await owner.rpc("instantiate_document", { p_source: d.doc.id, p_as_template: false });
    expect(bad.error?.message).toMatch(/não é um modelo/);
    // Outro colaborador não vê o documento, logo não o copia.
    const steal = await member.rpc("instantiate_document", { p_source: d.doc.id, p_as_template: true });
    expect(steal.error?.message).toMatch(/não encontrado/);
    // O dono guarda-o como modelo.
    const r = await instantiate(owner, { p_source: d.doc.id, p_as_template: true, p_title: "Modelo a partir de doc" }, d.path);
    expect(r.copyError).toBeNull();
    const { data: t } = await member.from("documents").select("is_template, title").eq("id", r.row!.new_document_id).single();
    expect(t).toEqual({ is_template: true, title: "Modelo a partir de doc" });
    // O membro não apaga o modelo de outro.
    const del = await member.rpc("delete_draft_document", { p_document_id: r.row!.new_document_id });
    expect(del.error).toBeTruthy();
    // Nem copia ficheiros para documentos que não são seus.
    const cp = await member.storage.from("documents").copy(d.path, `${ws}/${r.row!.new_document_id}/original.pdf`);
    expect(cp.error).toBeTruthy();
  });

  it("o painel de documentos não mostra modelos", async () => {
    const { data } = await owner.from("documents").select("id").eq("is_template", false);
    const { data: all } = await owner.from("documents").select("id, is_template");
    expect(data!.length).toBe(all!.filter((x) => !x.is_template).length);
  });
});
