// Emails do Signed (HTML simples, compatível com Outlook) e registo dos envios.

import type { SupabaseClient } from "@supabase/supabase-js";
import { type MailAttachment, m365Config, sendMail } from "./m365.ts";
import { formatLisbon } from "./util.ts";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(title: string, body: string, cta?: { label: string; url: string }, footer?: string): string {
  const button = cta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0"><tr><td style="background:#0f2445;border-radius:6px">
         <a href="${esc(cta.url)}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:600;font-family:Segoe UI,Arial,sans-serif;font-size:15px">${esc(cta.label)}</a>
       </td></tr></table>
       <p style="font-size:12px;color:#6b7280;margin:0">Se o botão não funcionar, copie este endereço:<br><span style="word-break:break-all">${esc(cta.url)}</span></p>`
    : "";
  return `<!doctype html><html lang="pt"><body style="margin:0;background:#f3f4f6;padding:24px 0">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
  <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:10px;padding:32px;font-family:Segoe UI,Arial,sans-serif;color:#111827">
    <tr><td style="font-size:20px;font-weight:700;color:#0f2445;padding-bottom:4px">Signed</td></tr>
    <tr><td style="font-size:12px;color:#6b7280;padding-bottom:20px">Altis Hotels · Assinatura eletrónica</td></tr>
    <tr><td style="font-size:18px;font-weight:600;padding-bottom:12px">${esc(title)}</td></tr>
    <tr><td style="font-size:15px;line-height:1.55">${body}${button}</td></tr>
    <tr><td style="font-size:12px;color:#9ca3af;padding-top:28px;border-top:1px solid #e5e7eb">${footer ?? "Este email foi enviado automaticamente pelo Signed, a plataforma de assinatura eletrónica do Grupo Altis Hotels. Não responda a este email."}</td></tr>
  </table></td></tr></table></body></html>`;
}

function para(s: string) {
  return `<p style="margin:0 0 12px">${s}</p>`;
}

function quote(msg: string | null) {
  return msg
    ? `<div style="border-left:3px solid #c7d2fe;padding:8px 12px;margin:12px 0;color:#374151;white-space:pre-wrap">${esc(msg)}</div>`
    : "";
}

export interface InviteData {
  recipientName: string;
  senderName: string;
  title: string;
  message: string | null;
  url: string;
  mode: "simple" | "qualified";
  step: "fill" | "sign";
  expiresAt: string | null;
  reminder?: boolean;
}

export function inviteEmail(d: InviteData): { subject: string; html: string } {
  const action =
    d.mode === "qualified"
      ? d.step === "fill"
        ? "preencher"
        : "assinar com o Cartão de Cidadão"
      : "assinar";
  const subject = `${d.reminder ? "Lembrete: " : ""}${d.senderName} pede-lhe para ${action}: ${d.title}`;
  let body = para(`Olá ${esc(d.recipientName)},`) +
    para(`<strong>${esc(d.senderName)}</strong> enviou-lhe o documento <strong>${esc(d.title)}</strong> para ${action}.`) +
    quote(d.message);
  if (d.mode === "qualified" && d.step === "sign") {
    body += para(
      "Vai precisar do seu <strong>Cartão de Cidadão com leitor</strong> (ou da <strong>Chave Móvel Digital</strong>) e da aplicação gratuita <strong>Autenticação.gov</strong> instalada no computador. A página explica cada passo.",
    );
  }
  if (d.expiresAt) body += para(`Prazo: ${esc(formatLisbon(d.expiresAt))}.`);
  return { subject, html: layout(d.reminder ? "Lembrete de documento pendente" : "Tem um documento à sua espera", body, { label: "Abrir documento", url: d.url }) };
}

export function otpEmail(name: string, title: string, code: string): { subject: string; html: string } {
  return {
    subject: `Código de acesso Signed: ${code}`,
    html: layout(
      "Código de acesso",
      para(`Olá ${esc(name)},`) +
        para(`Use este código para abrir o documento <strong>${esc(title)}</strong>:`) +
        `<p style="font-size:30px;letter-spacing:8px;font-weight:700;color:#0f2445;margin:16px 0">${code}</p>` +
        para("O código é válido durante 10 minutos. Se não pediu este código, ignore este email."),
    ),
  };
}

export function completedEmail(name: string, title: string, mode: "simple" | "qualified", links: { label: string; url: string }[]): { subject: string; html: string } {
  const list = links.length
    ? `<ul style="padding-left:18px">${links.map((l) => `<li><a href="${esc(l.url)}">${esc(l.label)}</a></li>`).join("")}</ul>` +
      para('<span style="font-size:12px;color:#6b7280">As ligações são válidas durante 7 dias.</span>')
    : para("Os documentos seguem em anexo.");
  const extra = mode === "qualified"
    ? para("O PDF assinado contém as assinaturas qualificadas e pode ser validado na aplicação Autenticação.gov ou no Adobe Acrobat.")
    : "";
  return {
    subject: `Concluído: ${title}`,
    html: layout("Documento concluído", para(`Olá ${esc(name)},`) + para(`Todos os signatários assinaram <strong>${esc(title)}</strong>.`) + extra + list),
  };
}

export function declinedEmail(ownerName: string, title: string, who: string, reason: string | null, url: string) {
  return {
    subject: `Rejeitado: ${title}`,
    html: layout(
      "Documento rejeitado",
      para(`Olá ${esc(ownerName)},`) + para(`<strong>${esc(who)}</strong> rejeitou o documento <strong>${esc(title)}</strong>.`) + quote(reason),
      { label: "Ver documento", url },
    ),
  };
}

export function expiredEmail(ownerName: string, title: string, url: string) {
  return {
    subject: `Expirado: ${title}`,
    html: layout("Documento expirado", para(`Olá ${esc(ownerName)},`) + para(`O prazo do documento <strong>${esc(title)}</strong> terminou sem todas as assinaturas.`), {
      label: "Ver documento",
      url,
    }),
  };
}

export function ccRejectedEmail(ownerName: string, title: string, who: string, reason: string, url: string) {
  return {
    subject: `Assinatura recusada: ${title}`,
    html: layout(
      "Uma assinatura com Cartão de Cidadão foi recusada",
      para(`Olá ${esc(ownerName)},`) +
        para(`O Signed recusou o PDF carregado por <strong>${esc(who)}</strong> no documento <strong>${esc(title)}</strong>:`) +
        quote(reason) +
        para("O signatário pode tentar de novo. Se o nome ou o nº de identificação civil estiverem errados, cancele e reenvie o documento com os dados corretos."),
      { label: "Ver documento", url },
    ),
  };
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/(p|div|tr|li)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface DeliverInput {
  to: string;
  subject: string;
  html: string;
  kind: string;
  documentId?: string | null;
  recipientId?: string | null;
  attachments?: MailAttachment[];
}

/**
 * Envia pelo Microsoft 365. Sem configuração (desenvolvimento), não envia e guarda o
 * texto no email_log para consulta.
 */
export async function deliver(sb: SupabaseClient, m: DeliverInput): Promise<boolean> {
  const cfg = m365Config();
  let status = "sent";
  let error: string | null = null;
  if (!cfg) {
    status = "skipped";
    console.log(`[email desativado] ${m.to} — ${m.subject}`);
  } else {
    try {
      await sendMail(cfg, { to: m.to, subject: m.subject, html: m.html, attachments: m.attachments });
    } catch (e) {
      status = "failed";
      error = String((e as Error).message ?? e).slice(0, 1000);
      console.error(error);
    }
  }
  await sb.from("email_log").insert({
    document_id: m.documentId ?? null,
    recipient_id: m.recipientId ?? null,
    to_email: m.to,
    subject: m.subject,
    kind: m.kind,
    status,
    error,
    body_text: status === "skipped" ? htmlToText(m.html) : null,
  });
  return status === "sent" || status === "skipped";
}
