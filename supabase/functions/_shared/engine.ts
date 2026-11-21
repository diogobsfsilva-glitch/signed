// Motor do fluxo: notificações, preparação do PDF para CC, conclusão e arquivo.
// Corre nas edge functions com a chave de serviço.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DocumentRow, FieldRow, RecipientRow } from "./types.ts";
import { isFillField } from "./types.ts";
import { allSigned, currentRecipients, fillPhaseDone } from "./workflow.ts";
import { flattenFields } from "./pdf.ts";
import { loadSealKey, type SealKey, sealPdf } from "./pades-sign.ts";
import { buildAuditCertificate } from "./audit-cert.ts";
import { completedEmail, deliver, inviteEmail } from "./email.ts";
import { m365Config, uploadToSharePoint } from "./m365.ts";
import { sha256Hex, toBase64 } from "./util.ts";
import { env } from "./http.ts";

export const BUCKET = "documents";

export function serviceClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Os URLs assinados do Storage usam SUPABASE_URL; em desenvolvimento local esse
 * endereço é interno (kong:8000). PUBLIC_API_URL corrige-o para o browser.
 */
export function publicUrl(url: string | undefined | null): string {
  if (!url) return "";
  const pub = Deno.env.get("PUBLIC_API_URL");
  if (!pub) return url;
  const internal = env("SUPABASE_URL").replace(/\/+$/, "");
  return url.startsWith(internal) ? pub.replace(/\/+$/, "") + url.slice(internal.length) : url;
}

export function appUrl(): string {
  return (Deno.env.get("APP_URL") || "http://127.0.0.1:5173").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Tokens dos links de assinatura: derivados por HMAC (o link pode ser reenviado
// nos lembretes sem guardar o token em claro na base de dados).
// ---------------------------------------------------------------------------
async function hmacKey(): Promise<CryptoKey> {
  const secret = env("SIGNER_LINK_SECRET");
  if (secret.length < 32) throw new Error("SIGNER_LINK_SECRET tem de ter pelo menos 32 caracteres");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function signerToken(recipientId: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), new TextEncoder().encode(`signer:${recipientId}`)));
  return toBase64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function tokenHash(token: string): Promise<string> {
  return sha256Hex(`signed-token:${token}`);
}

export async function signerUrl(recipientId: string): Promise<string> {
  return `${appUrl()}/s/${await signerToken(recipientId)}`;
}

// ---------------------------------------------------------------------------
// Acesso a dados
// ---------------------------------------------------------------------------
export interface Bundle {
  doc: DocumentRow;
  recipients: RecipientRow[];
  fields: FieldRow[];
  owner: { id: string; email: string; full_name: string | null };
}

export async function loadBundle(sb: SupabaseClient, docId: string): Promise<Bundle> {
  const { data: doc, error } = await sb.from("documents").select("*").eq("id", docId).single();
  if (error || !doc) throw new Error(`Documento não encontrado: ${docId}`);
  const [{ data: recipients }, { data: fields }, { data: owner }] = await Promise.all([
    sb.from("recipients").select("*").eq("document_id", docId).order("signing_order").order("created_at"),
    sb.from("fields").select("*").eq("document_id", docId).order("page").order("y"),
    sb.from("profiles").select("id, email, full_name").eq("id", doc.owner_id).single(),
  ]);
  return { doc, recipients: recipients ?? [], fields: fields ?? [], owner: owner! };
}

export async function audit(
  sb: SupabaseClient,
  docId: string,
  event: string,
  o: { recipientId?: string | null; actorUserId?: string | null; ip?: string | null; ua?: string | null; details?: Record<string, unknown> } = {},
) {
  const { error } = await sb.rpc("append_audit", {
    p_document_id: docId,
    p_event: event,
    p_recipient_id: o.recipientId ?? null,
    p_actor_user_id: o.actorUserId ?? null,
    p_ip: o.ip ?? null,
    p_user_agent: o.ua ?? null,
    p_details: o.details ?? {},
  });
  if (error) throw new Error(`Auditoria: ${error.message}`);
}

export async function download(sb: SupabaseClient, path: string): Promise<Uint8Array> {
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`Não foi possível ler ${path}: ${error?.message}`);
  return new Uint8Array(await data.arrayBuffer());
}

export async function upload(sb: SupabaseClient, path: string, bytes: Uint8Array): Promise<void> {
  const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`Não foi possível gravar ${path}: ${error.message}`);
}

export function docFolder(doc: Pick<DocumentRow, "workspace_id" | "id">): string {
  return `${doc.workspace_id}/${doc.id}`;
}

function ownerName(b: Bundle): string {
  return b.owner.full_name || b.owner.email;
}

// ---------------------------------------------------------------------------
// Trinco por documento (evita duas transições em simultâneo)
// ---------------------------------------------------------------------------
async function acquireLock(sb: SupabaseClient, docId: string): Promise<boolean> {
  const stale = new Date(Date.now() - 5 * 60_000).toISOString();
  for (let i = 0; i < 6; i++) {
    const { data } = await sb
      .from("documents")
      .update({ processing_lock: new Date().toISOString() })
      .eq("id", docId)
      .or(`processing_lock.is.null,processing_lock.lt.${stale}`)
      .select("id");
    if (data && data.length) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

async function releaseLock(sb: SupabaseClient, docId: string) {
  await sb.from("documents").update({ processing_lock: null }).eq("id", docId);
}

// ---------------------------------------------------------------------------
// Avançar o fluxo
// ---------------------------------------------------------------------------
export async function advance(sb: SupabaseClient, docId: string): Promise<void> {
  if (!(await acquireLock(sb, docId))) {
    console.warn(`advance: documento ${docId} ocupado; o agendador retoma mais tarde`);
    return;
  }
  try {
    for (let guard = 0; guard < 4; guard++) {
      const b = await loadBundle(sb, docId);
      if (b.doc.status !== "in_progress") return;
      const { doc } = b;

      if (doc.signature_mode === "qualified") {
        if (doc.phase === "fill" && fillPhaseDone(doc, b.recipients, b.fields)) {
          await prepareQualified(sb, b);
          continue;
        }
        if (doc.phase === "sign" && !doc.prepared_path) {
          await prepareQualified(sb, b);
          continue;
        }
      }
      if (allSigned(b.recipients)) {
        await finalize(sb, b);
        return;
      }
      await notifyCurrent(sb, b);
      return;
    }
  } finally {
    await releaseLock(sb, docId);
  }
}

async function notifyCurrent(sb: SupabaseClient, b: Bundle) {
  const current = currentRecipients(b.doc, b.recipients, b.fields);
  for (const r of current) {
    if (r.notified_phase === b.doc.phase && r.notified_at) continue;
    const step = b.doc.signature_mode === "qualified" ? b.doc.phase : "sign";
    const mail = inviteEmail({
      recipientName: r.name,
      senderName: ownerName(b),
      title: b.doc.title,
      message: b.doc.message,
      url: await signerUrl(r.id),
      mode: b.doc.signature_mode,
      step,
      expiresAt: b.doc.expires_at,
    });
    await deliver(sb, { to: r.email, subject: b.doc.subject || mail.subject, html: mail.html, kind: "invite", documentId: b.doc.id, recipientId: r.id });
    await sb
      .from("recipients")
      .update({
        notified_at: new Date().toISOString(),
        notified_phase: b.doc.phase,
        status: r.status === "pending" ? "notified" : r.status,
      })
      .eq("id", r.id);
    await audit(sb, b.doc.id, "recipient.notified", { recipientId: r.id, details: { email: r.email, step } });
  }
}

export async function remind(sb: SupabaseClient, b: Bundle, r: RecipientRow): Promise<void> {
  const step = b.doc.signature_mode === "qualified" ? b.doc.phase : "sign";
  const mail = inviteEmail({
    recipientName: r.name,
    senderName: ownerName(b),
    title: b.doc.title,
    message: b.doc.message,
    url: await signerUrl(r.id),
    mode: b.doc.signature_mode,
    step,
    expiresAt: b.doc.expires_at,
    reminder: true,
  });
  await deliver(sb, { to: r.email, subject: mail.subject, html: mail.html, kind: "reminder", documentId: b.doc.id, recipientId: r.id });
  await sb.from("recipients").update({ reminded_at: new Date().toISOString() }).eq("id", r.id);
  await audit(sb, b.doc.id, "recipient.reminded", { recipientId: r.id, details: { email: r.email } });
}

/** Modo CC: grava os valores preenchidos no PDF e cria a versão a assinar. */
async function prepareQualified(sb: SupabaseClient, b: Bundle) {
  const original = await download(sb, b.doc.original_path!);
  const fillFields = b.fields.filter((f) => isFillField(f.type, "qualified") || f.type === "signature");
  const prepared = await flattenFields(original, fillFields, {
    mode: "qualified",
    qualifiedPlaceholders: true,
    recipients: b.recipients,
  });
  const path = `${docFolder(b.doc)}/prepared.pdf`;
  await upload(sb, path, prepared);
  const hash = await sha256Hex(prepared);
  await sb
    .from("documents")
    .update({ phase: "sign", prepared_path: path, prepared_sha256: hash, current_path: path, current_sha256: hash })
    .eq("id", b.doc.id);
  await audit(sb, b.doc.id, "document.prepared", { details: { sha256: hash } });
}

let sealKeyPromise: Promise<SealKey | null> | null = null;
function sealKey(): Promise<SealKey | null> {
  if (!sealKeyPromise) {
    const cert = Deno.env.get("SEAL_CERT_PEM");
    const key = Deno.env.get("SEAL_KEY_PEM");
    sealKeyPromise = cert && key ? loadSealKey(cert.replace(/\\n/g, "\n"), key.replace(/\\n/g, "\n")) : Promise.resolve(null);
  }
  return sealKeyPromise;
}

function safeFileName(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 80) || "documento";
}

async function finalize(sb: SupabaseClient, b: Bundle) {
  const { doc } = b;
  const key = await sealKey();
  let finalBytes: Uint8Array;
  let finalLabel: string;
  if (doc.signature_mode === "qualified") {
    // O PDF assinado com CC não pode ser alterado (invalidaria as assinaturas).
    finalBytes = await download(sb, doc.current_path!);
    finalLabel = "do PDF assinado";
  } else {
    const original = await download(sb, doc.original_path!);
    const flat = await flattenFields(original, b.fields, { mode: "simple" });
    finalBytes = key ? await sealPdf(flat, key, { reason: "Documento assinado no Signed", name: "Signed - Altis Hotels" }) : flat;
    finalLabel = "do PDF final";
  }
  const finalPath = `${docFolder(doc)}/final.pdf`;
  await upload(sb, finalPath, finalBytes);
  const finalHash = await sha256Hex(finalBytes);
  const completedAt = new Date().toISOString();
  await audit(sb, doc.id, "document.completed", { details: { final_sha256: finalHash, sealed: !!key || doc.signature_mode === "qualified" } });

  const [{ data: events }, { data: intact }, { data: settings }] = await Promise.all([
    sb.from("audit_events").select("event, created_at, recipient_id, ip, hash").eq("document_id", doc.id).order("id"),
    sb.rpc("verify_audit_chain", { p_document_id: doc.id }),
    sb.from("app_settings").select("org_name").single(),
  ]);
  let cert = await buildAuditCertificate({
    orgName: settings?.org_name ?? "Altis Hotels",
    document: {
      id: doc.id,
      title: doc.title,
      signature_mode: doc.signature_mode,
      sent_at: doc.sent_at,
      completed_at: completedAt,
      original_sha256: doc.original_sha256,
      final_sha256: finalHash,
      final_label: finalLabel,
    },
    owner: { name: ownerName(b), email: b.owner.email },
    recipients: b.recipients,
    events: events ?? [],
    chainIntact: intact === true,
  });
  if (key) cert = await sealPdf(cert, key, { reason: "Certificado de conclusão", name: "Signed - Altis Hotels" });
  const auditPath = `${docFolder(doc)}/certificado.pdf`;
  await upload(sb, auditPath, cert);

  await sb
    .from("documents")
    .update({ status: "completed", completed_at: completedAt, final_path: finalPath, final_sha256: finalHash, audit_path: auditPath })
    .eq("id", doc.id);

  // Emails com os documentos
  const base = safeFileName(doc.title);
  const finalName = `${base}${doc.signature_mode === "qualified" ? "_assinado" : ""}.pdf`;
  const certName = `${base}_certificado.pdf`;
  const total = finalBytes.length + cert.length;
  let links: { label: string; url: string }[] = [];
  const attachments = total < 2_800_000
    ? [
      { name: finalName, contentType: "application/pdf", bytes: finalBytes },
      { name: certName, contentType: "application/pdf", bytes: cert },
    ]
    : [];
  if (!attachments.length) {
    const week = 7 * 24 * 3600;
    const [f, c] = await Promise.all([
      sb.storage.from(BUCKET).createSignedUrl(finalPath, week, { download: finalName }),
      sb.storage.from(BUCKET).createSignedUrl(auditPath, week, { download: certName }),
    ]);
    links = [
      { label: "Documento", url: publicUrl(f.data?.signedUrl) },
      { label: "Certificado de conclusão", url: publicUrl(c.data?.signedUrl) },
    ];
  }
  const people = new Map<string, string>();
  people.set(b.owner.email.toLowerCase(), ownerName(b));
  for (const r of b.recipients) if (r.status !== "declined") people.set(r.email.toLowerCase(), r.name);
  for (const [email, name] of people) {
    const mail = completedEmail(name, doc.title, doc.signature_mode, links);
    await deliver(sb, { to: email, subject: mail.subject, html: mail.html, kind: "completed", documentId: doc.id, attachments });
  }

  await archive(sb, { ...doc, title: doc.title }, [
    { name: finalName, bytes: finalBytes },
    { name: certName, bytes: cert },
  ]);
}

async function archive(sb: SupabaseClient, doc: DocumentRow, files: { name: string; bytes: Uint8Array }[]) {
  const cfg = m365Config();
  if (!cfg?.siteId) return;
  try {
    const { data: ws } = await sb.from("workspaces").select("name").eq("id", doc.workspace_id).single();
    const year = new Date().getFullYear();
    const folder = `${cfg.archiveFolder}/${year}/${safeFileName(ws?.name ?? "Geral")}/${safeFileName(doc.title)}_${doc.id.slice(0, 8)}`;
    let url = "";
    for (const f of files) {
      const u = await uploadToSharePoint(cfg, `${folder}/${f.name}`, f.bytes);
      if (!url) url = u;
    }
    await sb.from("documents").update({ archive_url: url, archive_error: null }).eq("id", doc.id);
    await audit(sb, doc.id, "document.archived", { details: { folder } });
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 500);
    await sb.from("documents").update({ archive_error: msg }).eq("id", doc.id);
    await audit(sb, doc.id, "document.archive_failed", { details: { error: msg } });
  }
}
