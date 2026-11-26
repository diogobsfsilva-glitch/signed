// Motor do fluxo: notificações, preparação do PDF para CC, conclusão e arquivo.
// Corre nas edge functions com a chave de serviço.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DocumentRow, FieldRow, RecipientRow } from "./types.ts";
import { autoFieldValue, isAutoField, parseAttachment, partRanges, partsProblem } from "./types.ts";
import { allSigned, currentRecipients, fillPhaseDone, validateForSend } from "./workflow.ts";
import { assertValidPdf, extractPages, flattenFields } from "./pdf.ts";
import { loadSealKey, type SealKey, sealPdf } from "./pades-sign.ts";
import { buildAuditCertificate } from "./audit-cert.ts";
import { type Brand, completedEmail, deliver, inviteEmail } from "./email.ts";
import { m365Config, uploadToSharePoint } from "./m365.ts";
import { randomToken, sha256Hex, toBase64 } from "./util.ts";
import { env, HttpError } from "./http.ts";

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

/** A versão muda quando o destinatário é corrigido ou delega; a versão 0 mantém o formato original. */
export async function signerToken(r: { id: string; token_version?: number | null }): Promise<string> {
  const v = r.token_version ?? 0;
  const msg = v ? `signer:${r.id}:${v}` : `signer:${r.id}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), new TextEncoder().encode(msg)));
  return toBase64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function tokenHash(token: string): Promise<string> {
  return sha256Hex(`signed-token:${token}`);
}

export async function signerUrl(r: { id: string; token_version?: number | null }): Promise<string> {
  return `${appUrl()}/s/${await signerToken(r)}`;
}

/** Cria uma sessão de signatário (depois do código por email, presencial ou link público). */
export async function createSignerSession(sb: SupabaseClient, recipientId: string, ttlMs: number): Promise<string> {
  const session = randomToken();
  const { error } = await sb.from("signer_sessions").insert({
    recipient_id: recipientId,
    token_hash: await sha256Hex(`session:${session}`),
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  });
  if (error) throw new Error(error.message);
  return session;
}

/** Valida e envia um rascunho (colaborador ou link público). */
export async function sendDocument(
  sb: SupabaseClient,
  b: Bundle,
  o: { actorUserId?: string | null; ip?: string | null; ua?: string | null },
): Promise<void> {
  if (b.doc.status !== "draft") throw new HttpError(409, "O documento já foi enviado.");
  const issues = validateForSend(b.doc, b.recipients, b.fields);
  if (issues.length) throw new HttpError(422, issues.map((i) => i.message).join("\n"), "validation");
  if (b.doc.expires_at && new Date(b.doc.expires_at) < new Date(Date.now() + 3600_000)) {
    throw new HttpError(422, "O prazo tem de ser pelo menos daqui a uma hora.", "validation");
  }
  if (b.doc.original_path !== `${b.doc.workspace_id}/${b.doc.id}/original.pdf`) {
    throw new HttpError(422, "Ficheiro do documento inválido.", "validation");
  }
  const pdf = await download(sb, b.doc.original_path!);
  const pages = await assertValidPdf(pdf).catch((e) => {
    throw new HttpError(422, (e as Error).message, "invalid_pdf");
  });
  if (b.fields.some((f) => f.page > pages)) throw new HttpError(422, "Há campos em páginas que não existem no PDF.", "validation");
  const pp = partsProblem(b.doc.parts, pages);
  if (pp) throw new HttpError(422, pp, "validation");
  const hash = await sha256Hex(pdf);
  for (const r of b.recipients) {
    await sb
      .from("recipients")
      .update({
        token_hash: r.role === "signer" ? await tokenHash(await signerToken(r)) : null,
        status: "pending",
        notified_at: null,
        notified_phase: null,
      })
      .eq("id", r.id);
  }
  const { data: updated } = await sb
    .from("documents")
    .update({ status: "in_progress", sent_at: new Date().toISOString(), phase: "fill", original_sha256: hash, page_count: pages })
    .eq("id", b.doc.id)
    .eq("status", "draft")
    .select("id");
  if (!updated?.length) throw new HttpError(409, "O documento já foi enviado.");
  await audit(sb, b.doc.id, "document.sent", {
    actorUserId: o.actorUserId ?? null,
    ip: o.ip,
    ua: o.ua,
    details: {
      original_sha256: hash,
      mode: b.doc.signature_mode,
      sequential: b.doc.sequential,
      recipients: b.recipients.map((r) => ({ name: r.name, email: r.email, role: r.role, order: r.signing_order, in_person: !!r.in_person })),
    },
  });
  await advance(sb, b.doc.id);
}

/** Estados em que um destinatário ainda pode ser corrigido ou delegar (ainda não agiu). */
export const REASSIGNABLE = ["pending", "notified", "viewed"];

/**
 * Troca a pessoa de um destinatário (correção pelo remetente ou delegação pelo signatário).
 * Se o email mudar, o link anterior, as sessões e os códigos deixam de valer e o convite é
 * reenviado a seguir por advance(). Os campos continuam atribuídos ao mesmo destinatário.
 */
export async function reassignRecipient(
  sb: SupabaseClient,
  r: RecipientRow,
  next: { name: string; email: string; civil_id: string | null },
): Promise<{ emailChanged: boolean }> {
  const email = next.email.trim().toLowerCase();
  const emailChanged = email !== r.email.toLowerCase();
  const patch: Record<string, unknown> = { name: next.name.trim(), email, civil_id: next.civil_id };
  if (email && r.group_emails?.length) patch.group_emails = null; // o grupo passa a ser uma pessoa
  if (email && r.in_person) patch.in_person = false; // com email, passa a receber o convite
  if (emailChanged) {
    const version = (r.token_version ?? 0) + 1;
    Object.assign(patch, {
      token_version: version,
      token_hash: r.role === "signer" ? await tokenHash(await signerToken({ id: r.id, token_version: version })) : null,
      status: "pending",
      notified_at: null,
      notified_phase: null,
      reminded_at: null,
      viewed_at: null,
    });
  }
  // Só altera se o estado não mudou entretanto (ex.: assinou enquanto o remetente corrigia).
  const { data: done, error } = await sb.from("recipients").update(patch).eq("id", r.id).eq("status", r.status).select("id");
  if (error) throw new Error(error.message);
  if (!done?.length) throw new HttpError(409, `${r.name} acabou de responder ao documento. Atualize a página.`, "wrong_step");
  if (emailChanged) {
    await sb.from("signer_sessions").delete().eq("recipient_id", r.id);
    await sb.from("signer_otps").delete().eq("recipient_id", r.id);
  }
  return { emailChanged };
}

/** Preenche os campos automáticos (nome, email, data de assinatura) de um signatário. */
export async function fillAutoFields(sb: SupabaseClient, b: Bundle, r: Pick<RecipientRow, "id" | "name" | "email">, now = new Date()) {
  for (const f of b.fields.filter((x) => x.recipient_id === r.id && isAutoField(x.type))) {
    await sb.from("fields").update({ value: autoFieldValue(f.type, r, now), filled_at: now.toISOString() }).eq("id", f.id);
  }
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

/** Marca do hotel (espaço de trabalho), se tiver cor ou logótipo definidos. */
export async function brandFor(sb: SupabaseClient, workspaceId: string): Promise<Brand | null> {
  const { data } = await sb.from("workspaces").select("name, brand_color, logo_path").eq("id", workspaceId).maybeSingle();
  if (!data || (!data.brand_color && !data.logo_path)) return null;
  const logoUrl = data.logo_path ? publicUrl(sb.storage.from("branding").getPublicUrl(data.logo_path).data.publicUrl) : null;
  return { name: data.name, color: data.brand_color ?? null, logoUrl };
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

/**
 * Corre uma alteração com o documento trancado: assinar, rejeitar, delegar, corrigir, cancelar e
 * expirar ficam em série com a conclusão, por isso nunca se decide com dados desatualizados.
 * A função recebe o documento lido já com o trinco.
 */
export async function withDocLock<T>(sb: SupabaseClient, docId: string, fn: (b: Bundle) => Promise<T>): Promise<T> {
  if (!(await acquireLock(sb, docId))) {
    throw new HttpError(409, "O documento está a ser atualizado. Tente de novo dentro de momentos.", "busy");
  }
  try {
    return await fn(await loadBundle(sb, docId));
  } finally {
    await releaseLock(sb, docId);
  }
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
  const brand = current.some((r) => !r.in_person) ? await brandFor(sb, b.doc.workspace_id) : null;
  for (const r of current) {
    if (r.notified_phase === b.doc.phase && r.notified_at) continue;
    const step = b.doc.signature_mode === "qualified" ? b.doc.phase : "sign";
    if (r.in_person) {
      // Sem convite: o colaborador abre a assinatura no seu dispositivo.
      await sb.from("recipients").update({ notified_at: new Date().toISOString(), notified_phase: b.doc.phase, status: r.status === "pending" ? "notified" : r.status }).eq("id", r.id);
      await audit(sb, b.doc.id, "recipient.awaiting_in_person", { recipientId: r.id });
      continue;
    }
    const mail = inviteEmail({
      recipientName: r.name,
      senderName: ownerName(b),
      title: b.doc.title,
      message: b.doc.message,
      url: await signerUrl(r),
      mode: b.doc.signature_mode,
      step,
      expiresAt: b.doc.expires_at,
      lang: r.language,
      brand,
      documents: b.doc.parts?.map((x) => x.name),
    });
    let delivered = 0;
    for (const to of recipientEmails(r)) {
      if (await deliver(sb, { to, subject: b.doc.subject || mail.subject, html: mail.html, kind: "invite", documentId: b.doc.id, recipientId: r.id })) delivered++;
    }
    if (!delivered) {
      // Não marca como notificado: o agendador volta a tentar na hora seguinte e o remetente vê a falha.
      await audit(sb, b.doc.id, "recipient.notify_failed", { recipientId: r.id, details: { email: recipientEmails(r).join(", ") } });
      continue;
    }
    await sb
      .from("recipients")
      .update({
        notified_at: new Date().toISOString(),
        notified_phase: b.doc.phase,
        status: r.status === "pending" ? "notified" : r.status,
      })
      .eq("id", r.id);
    await audit(sb, b.doc.id, "recipient.notified", { recipientId: r.id, details: { email: recipientEmails(r).join(", "), step } });
  }
}

/** Emails de um destinatário: o dele, ou os de todos os membros do grupo. */
export function recipientEmails(r: Pick<RecipientRow, "email" | "group_emails">): string[] {
  return r.group_emails?.length ? r.group_emails : r.email ? [r.email] : [];
}

export async function remind(sb: SupabaseClient, b: Bundle, r: RecipientRow): Promise<void> {
  if (r.in_person || !recipientEmails(r).length) return;
  const step = b.doc.signature_mode === "qualified" ? b.doc.phase : "sign";
  const mail = inviteEmail({
    recipientName: r.name,
    senderName: ownerName(b),
    title: b.doc.title,
    message: b.doc.message,
    url: await signerUrl(r),
    mode: b.doc.signature_mode,
    step,
    expiresAt: b.doc.expires_at,
    reminder: true,
    lang: r.language,
    brand: await brandFor(sb, b.doc.workspace_id),
    documents: b.doc.parts?.map((x) => x.name),
  });
  for (const to of recipientEmails(r)) {
    await deliver(sb, { to, subject: mail.subject, html: mail.html, kind: "reminder", documentId: b.doc.id, recipientId: r.id });
  }
  await sb.from("recipients").update({ reminded_at: new Date().toISOString() }).eq("id", r.id);
  await audit(sb, b.doc.id, "recipient.reminded", { recipientId: r.id, details: { email: recipientEmails(r).join(", ") } });
}

/** Modo CC: grava os valores preenchidos no PDF e cria a versão a assinar. */
async function prepareQualified(sb: SupabaseClient, b: Bundle) {
  // Campos automáticos ficam com os dados do signatário e a data de preparação.
  const now = new Date();
  for (const r of b.recipients.filter((x) => x.role === "signer")) await fillAutoFields(sb, b, r, now);
  const { data: fresh } = await sb.from("fields").select("*").eq("document_id", b.doc.id);
  const fillFields = (fresh ?? b.fields).filter((f) => f.type !== "initials");
  const original = await download(sb, b.doc.original_path!);
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
  let flat: Uint8Array | null = null;
  if (doc.signature_mode === "qualified") {
    // O PDF assinado com CC não pode ser alterado (invalidaria as assinaturas).
    finalBytes = await download(sb, doc.current_path!);
    finalLabel = "do PDF assinado";
  } else {
    const original = await download(sb, doc.original_path!);
    flat = await flattenFields(original, b.fields, { mode: "simple" });
    finalBytes = key ? await sealPdf(flat, key, { reason: "Documento assinado no Signed", name: "Signed - Altis Hotels" }) : flat;
    finalLabel = doc.parts && doc.parts.length > 1 ? "do pacote completo" : "do PDF final";
  }
  const finalPath = `${docFolder(doc)}/final.pdf`;
  await upload(sb, finalPath, finalBytes);
  const finalHash = await sha256Hex(finalBytes);

  // Pacote: cada documento também em separado. Na assinatura simples, cada um leva o seu selo;
  // no modo CC, as cópias separadas não têm as assinaturas (essas só valem no pacote completo).
  const separated: { name: string; label: string; from: number; to: number; path: string; bytes: Uint8Array; sha256: string }[] = [];
  if (doc.parts && doc.parts.length > 1) {
    for (const [i, part] of partRanges(doc.parts).entries()) {
      try {
        let bytes = await extractPages(flat ?? finalBytes, part.from, part.to);
        if (flat && key) bytes = await sealPdf(bytes, key, { reason: "Documento assinado no Signed", name: "Signed - Altis Hotels" });
        const path = `${docFolder(doc)}/final_part_${i + 1}.pdf`;
        await upload(sb, path, bytes);
        separated.push({ name: `${i + 1}_${safeFileName(part.name)}${flat ? "" : "_copia"}.pdf`, label: part.name, from: part.from, to: part.to, path, bytes, sha256: await sha256Hex(bytes) });
      } catch (e) {
        console.error(`parte ${i + 1} do pacote`, e);
      }
    }
  }
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
    attachments: attachmentsOf(b).map((a) => ({ recipient: a.recipient, name: a.file.name, size: a.file.size, sha256: a.file.sha256 })),
    parts: doc.parts && doc.parts.length > 1
      ? partRanges(doc.parts).map((p) => ({ ...p, sha256: separated.find((x) => x.from === p.from)?.sha256 ?? null }))
      : undefined,
    partsSigned: !!flat,
  });
  if (key) cert = await sealPdf(cert, key, { reason: "Certificado de conclusão", name: "Signed - Altis Hotels" });
  const auditPath = `${docFolder(doc)}/certificado.pdf`;
  await upload(sb, auditPath, cert);

  // Só conclui se continuar em curso (cancelar e expirar também usam o trinco, mas fica a garantia).
  const { data: completed, error: ce } = await sb
    .from("documents")
    .update({ status: "completed", completed_at: completedAt, final_path: finalPath, final_sha256: finalHash, audit_path: auditPath })
    .eq("id", doc.id)
    .eq("status", "in_progress")
    .select("id");
  if (ce) throw new Error(`Conclusão: ${ce.message}`);
  if (!completed?.length) {
    console.warn(`finalize: ${doc.id} deixou de estar em curso; conclusão anulada`);
    return;
  }

  // Emails com os documentos
  const base = safeFileName(doc.title);
  const finalName = `${base}${doc.signature_mode === "qualified" ? "_assinado" : ""}.pdf`;
  const certName = `${base}_certificado.pdf`;
  const total = finalBytes.length + cert.length;
  let links: { kind: "doc" | "cert"; url: string }[] = [];
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
      { kind: "doc", url: publicUrl(f.data?.signedUrl) },
      { kind: "cert", url: publicUrl(c.data?.signedUrl) },
    ];
  }
  const brand = await brandFor(sb, doc.workspace_id);
  const people = new Map<string, { name: string; lang: string; brand: Brand | null }>();
  people.set(b.owner.email.toLowerCase(), { name: ownerName(b), lang: "pt", brand: null });
  for (const r of b.recipients) {
    if (r.status === "declined") continue;
    // Num grupo, recebe a cópia quem assinou (ou todos, se ainda ninguém assinou, ex.: cópia).
    const to = r.signed_by ? [r.signed_by] : recipientEmails(r);
    for (const e of to) if (!people.has(e.toLowerCase())) people.set(e.toLowerCase(), { name: r.name, lang: r.language ?? "pt", brand });
  }
  for (const [email, { name, lang, brand: br }] of people) {
    const mail = completedEmail(name, doc.title, doc.signature_mode, links, { lang, brand: br });
    await deliver(sb, { to: email, subject: mail.subject, html: mail.html, kind: "completed", documentId: doc.id, attachments });
  }

  const archived = [
    { name: finalName, bytes: finalBytes },
    { name: certName, bytes: cert },
    ...separated.map((x) => ({ name: `Documentos/${x.name}`, bytes: x.bytes })),
  ];
  for (const [i, a] of attachmentsOf(b).entries()) {
    try {
      archived.push({ name: `Anexos/${i + 1}_${safeFileName(a.recipient)}_${a.file.name}`, bytes: await download(sb, a.file.path) });
    } catch (e) {
      console.error(`anexo em falta: ${a.file.path}`, e);
    }
  }
  await archive(sb, { ...doc, title: doc.title }, archived);
}

/** Anexos carregados pelos signatários (para o certificado e o arquivo). */
export function attachmentsOf(b: Bundle) {
  const names = new Map(b.recipients.map((r) => [r.id, r.name]));
  return b.fields
    .filter((f) => f.type === "attachment")
    .map((f) => ({ recipient: names.get(f.recipient_id) ?? "", label: f.label, file: parseAttachment(f.value) }))
    .filter((a): a is { recipient: string; label: string | null; file: NonNullable<ReturnType<typeof parseAttachment>> } => !!a.file);
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
