// API pública para os signatários (acesso pelo link do email + código de verificação).

import type { SupabaseClient } from "@supabase/supabase-js";
import { clientIp, handler, HttpError, json, readJson, userAgent } from "../_shared/http.ts";
import { advance, audit, brandFor, BUCKET, type Bundle, docFolder, download, fillAutoFields, loadBundle, REASSIGNABLE, reassignRecipient, serviceClient, tokenHash, upload, withDocLock } from "../_shared/engine.ts";
import { assertSignaturePng } from "../_shared/pdf.ts";
import { ccRejectedEmail, declinedEmail, delegatedEmail, deliver, otpEmail } from "../_shared/email.ts";
import { currentRecipients } from "../_shared/workflow.ts";
import { validateFieldValues } from "../_shared/workflow.ts";
import { type AttachmentValue, type FieldRow, isSignerInput, type RecipientRow } from "../_shared/types.ts";
import { maskEmail, nameMatches, randomCode, randomToken, sha256Hex } from "../_shared/util.ts";
import { matchSigner, trustStoreFromBase64, VerifyError, verifyIncrementalQualifiedSignature } from "../_shared/pades-verify.ts";
import { PT_INTERMEDIATES, PT_TRUST_ANCHORS } from "../_shared/trust-pt.ts";
import { appUrl, publicUrl } from "../_shared/engine.ts";

const OTP_TTL_MS = 10 * 60_000;
const OTP_RESEND_MS = 60_000;
const OTP_MAX_PER_HOUR = 5;
const SESSION_TTL_MS = 4 * 3600_000;

interface Body {
  action: string;
  token: string;
  session?: string;
  code?: string;
  values?: Record<string, string | null>;
  reason?: string;
  path?: string;
  field_id?: string;
  file_name?: string;
  /** grupo de assinatura: índice do membro escolhido */
  member?: number;
  name?: string;
  email?: string;
}

const MAX_ATTACHMENT = 10 * 1024 * 1024;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Nome de ficheiro seguro para o caminho no Storage (mantém a extensão). */
function safeName(name: string): string {
  const clean = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_");
  return clean.slice(-80).replace(/^[._]+/, "") || "anexo";
}

/** Tipo real do ficheiro pelos primeiros bytes (não confia na extensão). */
function sniff(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

/** Confirma o ficheiro carregado e devolve os dados guardados no campo. */
async function attachmentValue(sb: SupabaseClient, b: Bundle, r: RecipientRow, f: FieldRow, path: string): Promise<AttachmentValue> {
  const prefix = `${docFolder(b.doc)}/attachments/${r.id}-${f.id}-`;
  if (!path.startsWith(prefix)) throw new HttpError(400, "Anexo inválido.", "invalid_values");
  let bytes: Uint8Array;
  try {
    bytes = await download(sb, path);
  } catch {
    throw new HttpError(400, "O anexo não foi carregado. Tente de novo.", "invalid_values");
  }
  const type = sniff(bytes);
  if (!type) {
    await sb.storage.from(BUCKET).remove([path]);
    throw new HttpError(422, "O anexo tem de ser um PDF ou uma imagem (JPG ou PNG).", "invalid_values");
  }
  if (bytes.length > MAX_ATTACHMENT) {
    await sb.storage.from(BUCKET).remove([path]);
    throw new HttpError(422, "O anexo tem mais de 10 MB.", "invalid_values");
  }
  const rest = path.slice(prefix.length);
  const name = rest.slice(rest.indexOf("-") + 1) || "anexo";
  return { path, name, size: bytes.length, type, sha256: await sha256Hex(bytes) };
}

let trustCache: ReturnType<typeof trustStoreFromBase64> | null = null;
function trust() {
  // Em desenvolvimento é possível acrescentar uma PKI de teste (nunca em produção).
  if (!trustCache) {
    trustCache = trustStoreFromBase64(PT_TRUST_ANCHORS, PT_INTERMEDIATES);
    const extra = Deno.env.get("SIGNED_DEV_EXTRA_TRUST_PEM");
    if (extra) {
      const certs = [...extra.replace(/\\n/g, "\n").matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) => m[1].replace(/\s+/g, ""));
      const extraStore = trustStoreFromBase64({ a: certs[0] }, Object.fromEntries(certs.slice(1).map((c, i) => [String(i), c])));
      trustCache.anchors.push(...extraStore.anchors);
      trustCache.intermediates.push(...extraStore.intermediates);
      console.warn("ATENÇÃO: PKI de teste ativa (SIGNED_DEV_EXTRA_TRUST_PEM)");
    }
  }
  return trustCache;
}

async function findRecipient(sb: SupabaseClient, token: string): Promise<RecipientRow> {
  if (!token || token.length < 20) throw new HttpError(404, "Link inválido.", "invalid_link");
  const { data } = await sb.from("recipients").select("*").eq("token_hash", await tokenHash(token)).maybeSingle();
  if (!data) throw new HttpError(404, "Este link não é válido ou foi cancelado.", "invalid_link");
  return data;
}

async function requireSession(sb: SupabaseClient, r: RecipientRow, session?: string): Promise<{ member_email: string | null }> {
  if (!session) throw new HttpError(401, "Confirme o código de acesso.", "session_required");
  const { data } = await sb
    .from("signer_sessions")
    .select("id, expires_at, member_email")
    .eq("recipient_id", r.id)
    .eq("token_hash", await sha256Hex(`session:${session}`))
    .maybeSingle();
  if (!data || new Date(data.expires_at) < new Date()) {
    throw new HttpError(401, "A sessão expirou. Peça um novo código.", "session_required");
  }
  return { member_email: data.member_email ?? null };
}

function docState(b: Bundle, r: RecipientRow) {
  const cur = currentRecipients(b.doc, b.recipients, b.fields);
  const yourTurn = b.doc.status === "in_progress" && cur.some((c) => c.id === r.id);
  const myFields = b.fields.filter((f) => f.recipient_id === r.id);
  let step: "fill" | "sign_simple" | "sign_cc" | "wait" | "done" = "wait";
  if (r.status === "signed") step = "done";
  else if (r.status === "declined") step = "done";
  else if (!yourTurn) step = "wait";
  else if (b.doc.signature_mode === "simple") step = "sign_simple";
  else if (b.doc.phase === "fill") step = "fill";
  else step = "sign_cc";
  return { yourTurn, step, myFields };
}

function publicDoc(b: Bundle) {
  return {
    id: b.doc.id,
    title: b.doc.title,
    status: b.doc.status,
    mode: b.doc.signature_mode,
    phase: b.doc.phase,
    message: b.doc.message,
    pages: b.doc.pages,
    parts: b.doc.parts && b.doc.parts.length > 1 ? b.doc.parts : null,
    expires_at: b.doc.expires_at,
    sender: b.owner.full_name || b.owner.email,
  };
}

Deno.serve(handler(async (req) => {
  const body = await readJson<Body>(req);
  const sb = serviceClient();
  const ip = clientIp(req);
  const ua = userAgent(req);
  const r = await findRecipient(sb, body.token);
  const rid = r.id;
  if (r.role !== "signer") throw new HttpError(403, "Este link é apenas para consulta.", "not_signer");
  let b = await loadBundle(sb, r.document_id);

  // Expiração verificada no momento do acesso (o agendador também a aplica).
  if (b.doc.status === "in_progress" && b.doc.expires_at && new Date(b.doc.expires_at) < new Date()) {
    throw new HttpError(410, "O prazo para assinar este documento terminou.", "expired");
  }

  switch (body.action) {
    case "start": {
      return json({
        recipient: {
          name: r.name, email: r.email ? maskEmail(r.email) : "", status: r.status, in_person: !!r.in_person, language: r.language ?? "pt",
          group: r.group_emails?.length ? r.group_emails.map(maskEmail) : null,
        },
        brand: await brandFor(sb, b.doc.workspace_id),
        document: { title: b.doc.title, status: b.doc.status, sender: b.owner.full_name || b.owner.email, mode: b.doc.signature_mode },
      });
    }

    case "send-otp": {
      if (b.doc.status !== "in_progress") throw new HttpError(409, "Este documento já não está disponível para assinatura.", "not_active");
      if (r.in_person || (!r.email && !r.group_emails?.length)) throw new HttpError(403, "Esta assinatura é presencial: peça ao colaborador que a abra no dispositivo dele.", "in_person");
      // Grupo: o código vai para o membro escolhido.
      let to = r.email;
      if (r.group_emails?.length) {
        const m = r.group_emails[body.member ?? -1];
        if (!m) throw new HttpError(400, "Escolha o seu email.", "member_required");
        to = m;
      }
      const { data: prev } = await sb.from("signer_otps").select("sent_at").eq("recipient_id", r.id).maybeSingle();
      if (prev && Date.now() - new Date(prev.sent_at).getTime() < OTP_RESEND_MS) {
        throw new HttpError(429, "Aguarde um minuto antes de pedir outro código.", "rate_limited");
      }
      // Limite global: cada reenvio repõe as 5 tentativas, por isso limita-se também o número de códigos por hora.
      const { count: sentLastHour } = await sb
        .from("audit_events")
        .select("id", { count: "exact", head: true })
        .eq("recipient_id", r.id)
        .eq("event", "recipient.otp_sent")
        .gte("created_at", new Date(Date.now() - 3600_000).toISOString());
      if ((sentLastHour ?? 0) >= OTP_MAX_PER_HOUR) {
        throw new HttpError(429, "Pediu demasiados códigos. Tente de novo dentro de uma hora.", "otp_hourly");
      }
      const code = randomCode();
      await sb.from("signer_otps").upsert({
        recipient_id: r.id,
        code_hash: await sha256Hex(`${r.id}:${code}`),
        expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
        attempts: 0,
        sent_at: new Date().toISOString(),
        member_email: r.group_emails?.length ? to : null,
      });
      const mail = otpEmail(r.name, b.doc.title, code, { lang: r.language, brand: await brandFor(sb, b.doc.workspace_id) });
      if (!(await deliver(sb, { to, subject: mail.subject, html: mail.html, kind: "otp", documentId: b.doc.id, recipientId: r.id }))) {
        await sb.from("signer_otps").delete().eq("recipient_id", r.id);
        throw new HttpError(502, "Não foi possível enviar o código. Tente de novo dentro de momentos.", "email_failed");
      }
      await audit(sb, b.doc.id, "recipient.otp_sent", { recipientId: r.id, ip, ua, details: r.group_emails?.length ? { member: to } : {} });
      return json({ ok: true, email: maskEmail(to) });
    }

    case "verify-otp": {
      const { data: otp } = await sb.from("signer_otps").select("*").eq("recipient_id", r.id).maybeSingle();
      if (!otp || new Date(otp.expires_at) < new Date()) throw new HttpError(400, "O código expirou. Peça um novo.", "otp_expired");
      if (otp.attempts >= 5) throw new HttpError(429, "Demasiadas tentativas. Peça um novo código.", "otp_locked");
      // Cada tentativa consome uma das 5 de forma atómica (comparar-e-trocar): pedidos em paralelo
      // não conseguem fazer mais comparações do que as permitidas.
      const { data: claimed } = await sb
        .from("signer_otps")
        .update({ attempts: otp.attempts + 1 })
        .eq("recipient_id", r.id)
        .eq("attempts", otp.attempts)
        .eq("code_hash", otp.code_hash)
        .select("recipient_id");
      if (!claimed?.length) throw new HttpError(429, "Aguarde um pouco antes de tentar de novo.", "rate_limited");
      const ok = otp.code_hash === (await sha256Hex(`${r.id}:${(body.code ?? "").trim()}`));
      if (!ok) {
        await audit(sb, b.doc.id, "recipient.otp_failed", { recipientId: r.id, ip, ua });
        throw new HttpError(400, "Código incorreto.", "otp_wrong");
      }
      await sb.from("signer_otps").delete().eq("recipient_id", r.id);
      const session = randomToken();
      await sb.from("signer_sessions").insert({
        recipient_id: r.id,
        token_hash: await sha256Hex(`session:${session}`),
        expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        member_email: otp.member_email ?? null,
      });
      await audit(sb, b.doc.id, "recipient.authenticated", { recipientId: r.id, ip, ua });
      if (!r.viewed_at) {
        await sb
          .from("recipients")
          .update({ viewed_at: new Date().toISOString(), status: ["pending", "notified"].includes(r.status) ? "viewed" : r.status })
          .eq("id", r.id);
        await audit(sb, b.doc.id, "recipient.viewed", { recipientId: r.id, ip, ua });
      }
      return json({ session });
    }
  }

  // A partir daqui é preciso sessão.
  const sess = await requireSession(sb, r, body.session);

  switch (body.action) {
    case "load": {
      const st = docState(b, r);
      // PDF a mostrar: na fase de assinatura CC, a versão atual; caso contrário, o original.
      const path = b.doc.status === "completed" && b.doc.final_path
        ? b.doc.final_path
        : b.doc.signature_mode === "qualified" && b.doc.phase === "sign" && b.doc.current_path
        ? b.doc.current_path
        : b.doc.original_path!;
      const { data: url } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
      const showOverlay = path === b.doc.original_path;
      const others = showOverlay
        ? b.fields
          .filter((f) => f.recipient_id !== r.id && f.value)
          .map((f) => ({ id: f.id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, value: f.value, options: f.options }))
        : [];
      return json({
        document: publicDoc(b),
        recipient: { id: r.id, name: r.name, status: r.status, color: r.color },
        step: st.step,
        yourTurn: st.yourTurn,
        pdfUrl: publicUrl(url?.signedUrl),
        overlay: showOverlay,
        fields: showOverlay
          ? st.myFields.map((f) => ({
            id: f.id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required,
            label: f.label, options: f.options, value: f.value, readonly: !!f.readonly,
            editable: isSignerInput(f, b.doc.signature_mode),
          }))
          : [],
        others,
      });
    }

    case "submit": {
      // Tudo com o documento trancado e relido: duas submissões, ou submeter e rejeitar/cancelar
      // ao mesmo tempo, já não se cruzam.
      await withDocLock(sb, b.doc.id, async (b) => {
      const r = b.recipients.find((x) => x.id === rid);
      if (!r) throw new HttpError(404, "Este link não é válido ou foi cancelado.", "invalid_link");
      const st = docState(b, r);
      if (st.step !== "sign_simple" && st.step !== "fill") throw new HttpError(409, "Não é possível submeter neste momento.", "wrong_step");
      const editable = st.myFields.filter((f) => isSignerInput(f, b.doc.signature_mode));
      const values = body.values ?? {};
      const errors = validateFieldValues(editable, values);
      if (errors.length) throw new HttpError(422, errors.join(" "), "invalid_values");
      for (const f of editable.filter((x) => (x.type === "signature" || x.type === "initials") && values[x.id])) {
        await assertSignaturePng(values[f.id]!).catch(() => {
          throw new HttpError(422, "A imagem da assinatura não é válida. Desenhe-a ou carregue-a de novo.", "bad_signature");
        });
      }
      const attachments = new Map<string, AttachmentValue>();
      for (const f of editable.filter((x) => x.type === "attachment" && values[x.id])) {
        attachments.set(f.id, await attachmentValue(sb, b, r, f, values[f.id]!));
      }
      const now = new Date().toISOString();
      for (const f of editable) {
        const v = values[f.id];
        const stored = attachments.has(f.id) ? JSON.stringify(attachments.get(f.id)) : v === undefined || v === "" ? null : v;
        const { error } = await sb.from("fields").update({ value: stored, filled_at: now }).eq("id", f.id);
        if (error) throw new Error(`Campo ${f.id}: ${error.message}`);
      }
      for (const a of attachments.values()) {
        await audit(sb, b.doc.id, "recipient.attachment_added", { recipientId: r.id, ip, ua, details: { name: a.name, size: a.size, sha256: a.sha256 } });
      }
      if (b.doc.signature_mode === "simple") await fillAutoFields(sb, b, r, new Date(now));
      const valuesHash = await sha256Hex(JSON.stringify(editable.map((f) => [f.id, values[f.id] ?? null])));
      if (b.doc.signature_mode === "simple") {
        const { error } = await sb.from("recipients").update({ status: "signed", signed_at: now, filled_at: now, sign_ip: ip, sign_user_agent: ua, signed_by: sess.member_email }).eq("id", r.id);
        if (error) throw new Error(error.message);
        await audit(sb, b.doc.id, "recipient.signed", {
          recipientId: r.id, ip, ua,
          details: { fields: editable.length, values_sha256: valuesHash, ...(sess.member_email ? { signed_by: sess.member_email } : {}) },
        });
      } else {
        const { error } = await sb.from("recipients").update({ status: "filled", filled_at: now }).eq("id", r.id);
        if (error) throw new Error(error.message);
        await audit(sb, b.doc.id, "recipient.filled", { recipientId: r.id, ip, ua, details: { fields: editable.length, values_sha256: valuesHash } });
      }
      });
      await advance(sb, b.doc.id);
      return json({ ok: true });
    }

    case "decline": {
      const reason = (body.reason ?? "").trim().slice(0, 1000) || null;
      await withDocLock(sb, b.doc.id, async (b) => {
        const r = b.recipients.find((x) => x.id === rid);
        if (!r || b.doc.status !== "in_progress" || r.status === "signed" || r.status === "declined") {
          throw new HttpError(409, "Já não é possível rejeitar este documento.", "wrong_step");
        }
        const now = new Date().toISOString();
        await sb.from("recipients").update({ status: "declined", declined_at: now, decline_reason: reason }).eq("id", r.id);
        await sb.from("documents").update({ status: "declined" }).eq("id", b.doc.id).eq("status", "in_progress");
        await audit(sb, b.doc.id, "recipient.declined", { recipientId: r.id, ip, ua, details: { reason } });
        await audit(sb, b.doc.id, "document.declined", { recipientId: r.id });
      });
      const mail = declinedEmail(b.owner.full_name || b.owner.email, b.doc.title, r.name, reason, `${appUrl()}/documentos/${b.doc.id}`);
      await deliver(sb, { to: b.owner.email, subject: mail.subject, html: mail.html, kind: "declined", documentId: b.doc.id });
      return json({ ok: true });
    }

    case "attachment-upload-url": {
      const st = docState(b, r);
      if (st.step !== "sign_simple" && st.step !== "fill") throw new HttpError(409, "Não é possível carregar anexos neste momento.", "wrong_step");
      const f = st.myFields.find((x) => x.id === body.field_id && x.type === "attachment");
      if (!f) throw new HttpError(404, "Campo de anexo não encontrado.");
      const name = safeName(body.file_name ?? "anexo");
      if (!/\.(pdf|jpe?g|png)$/i.test(name)) throw new HttpError(422, "O anexo tem de ser um PDF ou uma imagem (JPG ou PNG).", "invalid_values");
      const path = `${docFolder(b.doc)}/attachments/${r.id}-${f.id}-${Date.now()}-${name}`;
      const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error) throw error;
      return json({ path, uploadToken: data.token });
    }

    case "delegate": {
      const name = (body.name ?? "").trim();
      const email = (body.email ?? "").trim().toLowerCase();
      const reason = (body.reason ?? "").trim().slice(0, 1000) || null;
      if (!name || name.length > 200) throw new HttpError(422, "Indique o nome da pessoa.", "validation");
      if (!EMAIL_RE.test(email)) throw new HttpError(422, "Indique um email válido.", "validation");
      if (email === r.email.toLowerCase()) throw new HttpError(422, "Indique o email de outra pessoa.", "validation");
      if (b.recipients.some((x) => x.id !== r.id && x.email.toLowerCase() === email)) {
        throw new HttpError(422, "Essa pessoa já é destinatária deste documento.", "validation");
      }
      const from = { name: r.name, email: r.email };
      await withDocLock(sb, b.doc.id, async (b) => {
        const cur = b.recipients.find((x) => x.id === rid);
        if (!cur || b.doc.status !== "in_progress" || !REASSIGNABLE.includes(cur.status)) {
          throw new HttpError(409, "Já não é possível delegar este documento.", "wrong_step");
        }
        await reassignRecipient(sb, cur, { name, email, civil_id: null });
        await audit(sb, b.doc.id, "recipient.delegated", { recipientId: cur.id, ip, ua, details: { from, to: { name, email }, reason } });
      });
      const mail = delegatedEmail(b.owner.full_name || b.owner.email, b.doc.title, from.name, name, email, reason, `${appUrl()}/documentos/${b.doc.id}`);
      await deliver(sb, { to: b.owner.email, subject: mail.subject, html: mail.html, kind: "delegated", documentId: b.doc.id });
      await advance(sb, b.doc.id);
      return json({ ok: true });
    }

    case "cc-download": {
      const st = docState(b, r);
      if (st.step !== "sign_cc") throw new HttpError(409, "Ainda não é a sua vez de assinar.", "wrong_step");
      const name = `${b.doc.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "documento"}_para_assinar.pdf`;
      const { data } = await sb.storage.from(BUCKET).createSignedUrl(b.doc.current_path!, 900, { download: name });
      await audit(sb, b.doc.id, "recipient.cc_downloaded", { recipientId: r.id, ip, ua, details: { sha256: b.doc.current_sha256 } });
      return json({ url: publicUrl(data?.signedUrl), sha256: b.doc.current_sha256, fileName: name });
    }

    case "cc-upload-url": {
      const st = docState(b, r);
      if (st.step !== "sign_cc") throw new HttpError(409, "Ainda não é a sua vez de assinar.", "wrong_step");
      const path = `${docFolder(b.doc)}/uploads/${r.id}-${Date.now()}.pdf`;
      const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error) throw error;
      return json({ path, uploadToken: data.token });
    }

    case "cc-submit": {
      const st = docState(b, r);
      if (st.step !== "sign_cc") throw new HttpError(409, "Ainda não é a sua vez de assinar.", "wrong_step");
      const path = body.path ?? "";
      if (!path.startsWith(`${docFolder(b.doc)}/uploads/${r.id}-`)) throw new HttpError(400, "Ficheiro inválido.");
      const previous = await download(sb, b.doc.current_path!);
      const uploaded = await download(sb, path);
      try {
        const result = await verifyIncrementalQualifiedSignature(previous, uploaded, { trust: trust() });
        const who = matchSigner(result.signer, { name: r.name, civil_id: r.civil_id }, nameMatches);
        if (!who.ok) throw new VerifyError(who.reason!, "wrong_person");

        // Grava a nova revisão com o documento trancado, confirmando que nada mudou durante a validação.
        const verifiedSha = b.doc.current_sha256;
        await withDocLock(sb, b.doc.id, async (b) => {
        const r = b.recipients.find((x) => x.id === rid);
        if (!r || docState(b, r).step !== "sign_cc" || b.doc.current_sha256 !== verifiedSha) {
          throw new HttpError(409, "O documento mudou entretanto. Atualize a página.", "wrong_step");
        }
        const n = b.recipients.filter((x) => x.status === "signed").length + 1;
        const newPath = `${docFolder(b.doc)}/signed-${n}.pdf`;
        await upload(sb, newPath, uploaded);
        await sb.storage.from(BUCKET).remove([path]);
        const now = new Date().toISOString();
        await sb.from("documents").update({ current_path: newPath, current_sha256: result.newSha256 }).eq("id", b.doc.id);
        await sb
          .from("recipients")
          .update({
            status: "signed",
            signed_at: now,
            sign_ip: ip,
            sign_user_agent: ua,
            cert_subject: result.signer.subject,
            cert_issuer: result.signer.issuer,
            cert_serial: result.signer.serial,
            cert_serial_number_attr: result.signer.serialNumberAttr,
          })
          .eq("id", r.id);
        await audit(sb, b.doc.id, "recipient.cc_signed", {
          recipientId: r.id,
          ip,
          ua,
          details: {
            certificate: result.signer.subject,
            issuer: result.signer.issuer,
            serial: result.signer.serial,
            signing_time: result.signingTime,
            sha256: result.newSha256,
            chain: result.chain.map((c) => c.commonName),
            timestamps: result.docTimestamps,
          },
        });
        });
        await advance(sb, b.doc.id);
        b = await loadBundle(sb, b.doc.id);
        return json({ ok: true, signer: result.signer.commonName, completed: b.doc.status === "completed" });
      } catch (e) {
        await sb.storage.from(BUCKET).remove([path]);
        if (e instanceof VerifyError) {
          await audit(sb, b.doc.id, "recipient.cc_rejected", { recipientId: r.id, ip, ua, details: { code: e.code, reason: e.message } });
          if (e.code === "wrong_person") {
            const mail = ccRejectedEmail(b.owner.full_name || b.owner.email, b.doc.title, r.name, e.message, `${appUrl()}/documentos/${b.doc.id}`);
            await deliver(sb, { to: b.owner.email, subject: mail.subject, html: mail.html, kind: "cc_rejected", documentId: b.doc.id });
          }
          throw new HttpError(422, e.message, e.code);
        }
        throw e;
      }
    }
  }
  throw new HttpError(400, "Ação desconhecida.");
}));
