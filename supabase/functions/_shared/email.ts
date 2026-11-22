// Emails do Signed (HTML simples, compatível com Outlook) e registo dos envios.

import type { SupabaseClient } from "@supabase/supabase-js";
import { type MailAttachment, m365Config, sendMail } from "./m365.ts";
import { formatLisbon } from "./util.ts";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export type Lang = "pt" | "en" | "es" | "fr";

/** Marca do hotel (espaço de trabalho) nos emails ao signatário. */
export interface Brand {
  name: string;
  color: string | null;
  logoUrl: string | null;
}

const L = {
  pt: {
    tagline: "Altis Hotels · Assinatura eletrónica",
    fallback: "Se o botão não funcionar, copie este endereço:",
    footer: "Este email foi enviado automaticamente pelo Signed, a plataforma de assinatura eletrónica do Grupo Altis Hotels. Não responda a este email.",
    hello: (n: string) => `Olá ${n},`,
    act_fill: "preencher", act_cc: "assinar com o Cartão de Cidadão", act_sign: "assinar",
    reminder: "Lembrete: ",
    invite_subject: (s: string, a: string, t: string) => `${s} pede-lhe para ${a}: ${t}`,
    invite_body: (s: string, t: string, a: string) => `<strong>${s}</strong> enviou-lhe o documento <strong>${t}</strong> para ${a}.`,
    cc_needs: "Vai precisar do seu <strong>Cartão de Cidadão com leitor</strong> (ou da <strong>Chave Móvel Digital</strong>) e da aplicação gratuita <strong>Autenticação.gov</strong> instalada no computador. A página explica cada passo.",
    deadline: (d: string) => `Prazo: ${d}.`,
    invite_title: "Tem um documento à sua espera", reminder_title: "Lembrete de documento pendente", open: "Abrir documento",
    otp_subject: (c: string) => `Código de acesso Signed: ${c}`, otp_title: "Código de acesso",
    otp_use: (t: string) => `Use este código para abrir o documento <strong>${t}</strong>:`,
    otp_valid: "O código é válido durante 10 minutos. Se não pediu este código, ignore este email.",
    links_valid: "As ligações são válidas durante 7 dias.", attached: "Os documentos seguem em anexo.",
    cc_validate: "O PDF assinado contém as assinaturas qualificadas e pode ser validado na aplicação Autenticação.gov ou no Adobe Acrobat.",
    done_subject: (t: string) => `Concluído: ${t}`, done_title: "Documento concluído",
    done_body: (t: string) => `Todos os signatários assinaram <strong>${t}</strong>.`,
    doc: "Documento", cert: "Certificado de conclusão",
  },
  en: {
    tagline: "Altis Hotels · Electronic signature",
    fallback: "If the button does not work, copy this address:",
    footer: "This email was sent automatically by Signed, the electronic signature platform of Altis Hotels Group. Please do not reply.",
    hello: (n: string) => `Hello ${n},`,
    act_fill: "fill in", act_cc: "sign with the Citizen Card", act_sign: "sign",
    reminder: "Reminder: ",
    invite_subject: (s: string, a: string, t: string) => `${s} asks you to ${a}: ${t}`,
    invite_body: (s: string, t: string, a: string) => `<strong>${s}</strong> sent you the document <strong>${t}</strong> to ${a}.`,
    cc_needs: "You will need your <strong>Portuguese Citizen Card with a card reader</strong> (or the <strong>Digital Mobile Key</strong>) and the free <strong>Autenticação.gov</strong> app installed on your computer. The page explains each step.",
    deadline: (d: string) => `Deadline: ${d}.`,
    invite_title: "A document is waiting for you", reminder_title: "Reminder: pending document", open: "Open document",
    otp_subject: (c: string) => `Signed access code: ${c}`, otp_title: "Access code",
    otp_use: (t: string) => `Use this code to open the document <strong>${t}</strong>:`,
    otp_valid: "The code is valid for 10 minutes. If you did not request it, please ignore this email.",
    links_valid: "The links are valid for 7 days.", attached: "The documents are attached.",
    cc_validate: "The signed PDF contains the qualified signatures and can be validated in the Autenticação.gov app or Adobe Acrobat.",
    done_subject: (t: string) => `Completed: ${t}`, done_title: "Document completed",
    done_body: (t: string) => `All signers have signed <strong>${t}</strong>.`,
    doc: "Document", cert: "Certificate of completion",
  },
  es: {
    tagline: "Altis Hotels · Firma electrónica",
    fallback: "Si el botón no funciona, copie esta dirección:",
    footer: "Este correo lo ha enviado automáticamente Signed, la plataforma de firma electrónica del Grupo Altis Hotels. No responda a este correo.",
    hello: (n: string) => `Hola, ${n}:`,
    act_fill: "rellenar", act_cc: "firmar con la Tarjeta de Ciudadano", act_sign: "firmar",
    reminder: "Recordatorio: ",
    invite_subject: (s: string, a: string, t: string) => `${s} le pide ${a}: ${t}`,
    invite_body: (s: string, t: string, a: string) => `<strong>${s}</strong> le ha enviado el documento <strong>${t}</strong> para ${a}.`,
    cc_needs: "Necesitará su <strong>Tarjeta de Ciudadano portuguesa con lector</strong> (o la <strong>Chave Móvel Digital</strong>) y la aplicación gratuita <strong>Autenticação.gov</strong> instalada en el ordenador. La página explica cada paso.",
    deadline: (d: string) => `Plazo: ${d}.`,
    invite_title: "Tiene un documento pendiente", reminder_title: "Recordatorio de documento pendiente", open: "Abrir documento",
    otp_subject: (c: string) => `Código de acceso de Signed: ${c}`, otp_title: "Código de acceso",
    otp_use: (t: string) => `Use este código para abrir el documento <strong>${t}</strong>:`,
    otp_valid: "El código es válido durante 10 minutos. Si no lo ha pedido, ignore este correo.",
    links_valid: "Los enlaces son válidos durante 7 días.", attached: "Los documentos van adjuntos.",
    cc_validate: "El PDF firmado contiene las firmas cualificadas y se puede validar en la aplicación Autenticação.gov o en Adobe Acrobat.",
    done_subject: (t: string) => `Completado: ${t}`, done_title: "Documento completado",
    done_body: (t: string) => `Todos los firmantes han firmado <strong>${t}</strong>.`,
    doc: "Documento", cert: "Certificado de finalización",
  },
  fr: {
    tagline: "Altis Hotels · Signature électronique",
    fallback: "Si le bouton ne fonctionne pas, copiez cette adresse :",
    footer: "Cet e-mail a été envoyé automatiquement par Signed, la plateforme de signature électronique du Groupe Altis Hotels. Merci de ne pas y répondre.",
    hello: (n: string) => `Bonjour ${n},`,
    act_fill: "remplir", act_cc: "signer avec la carte de citoyen", act_sign: "signer",
    reminder: "Rappel : ",
    invite_subject: (s: string, a: string, t: string) => `${s} vous demande de ${a} : ${t}`,
    invite_body: (s: string, t: string, a: string) => `<strong>${s}</strong> vous a envoyé le document <strong>${t}</strong> à ${a}.`,
    cc_needs: "Vous aurez besoin de votre <strong>carte de citoyen portugaise avec un lecteur</strong> (ou de la <strong>Chave Móvel Digital</strong>) et de l'application gratuite <strong>Autenticação.gov</strong> installée sur votre ordinateur. La page explique chaque étape.",
    deadline: (d: string) => `Délai : ${d}.`,
    invite_title: "Un document vous attend", reminder_title: "Rappel : document en attente", open: "Ouvrir le document",
    otp_subject: (c: string) => `Code d'accès Signed : ${c}`, otp_title: "Code d'accès",
    otp_use: (t: string) => `Utilisez ce code pour ouvrir le document <strong>${t}</strong> :`,
    otp_valid: "Le code est valable 10 minutes. Si vous ne l'avez pas demandé, ignorez cet e-mail.",
    links_valid: "Les liens sont valables 7 jours.", attached: "Les documents sont en pièce jointe.",
    cc_validate: "Le PDF signé contient les signatures qualifiées et peut être vérifié dans l'application Autenticação.gov ou dans Adobe Acrobat.",
    done_subject: (t: string) => `Terminé : ${t}`, done_title: "Document terminé",
    done_body: (t: string) => `Tous les signataires ont signé <strong>${t}</strong>.`,
    doc: "Document", cert: "Certificat d'achèvement",
  },
} as const;

const tx = (lang?: string | null) => L[(lang && lang in L ? lang : "pt") as Lang];

function layout(title: string, body: string, cta?: { label: string; url: string }, footer?: string, o: { lang?: string | null; brand?: Brand | null } = {}): string {
  const t = tx(o.lang);
  const color = o.brand?.color ?? "#0f2445";
  const button = cta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0"><tr><td style="background:${color};border-radius:6px">
         <a href="${esc(cta.url)}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:600;font-family:Segoe UI,Arial,sans-serif;font-size:15px">${esc(cta.label)}</a>
       </td></tr></table>
       <p style="font-size:12px;color:#6b7280;margin:0">${t.fallback}<br><span style="word-break:break-all">${esc(cta.url)}</span></p>`
    : "";
  const head = o.brand?.logoUrl
    ? `<tr><td style="padding-bottom:6px"><img src="${esc(o.brand.logoUrl)}" alt="${esc(o.brand.name)}" style="max-height:48px;max-width:220px;border:0"></td></tr>
       <tr><td style="font-size:12px;color:#6b7280;padding-bottom:20px">${esc(o.brand.name)} · ${esc(t.tagline.split(" · ")[1])}</td></tr>`
    : o.brand
    ? `<tr><td style="font-size:20px;font-weight:700;color:${color};padding-bottom:4px">${esc(o.brand.name)}</td></tr>
       <tr><td style="font-size:12px;color:#6b7280;padding-bottom:20px">${esc(t.tagline)}</td></tr>`
    : `<tr><td style="font-size:20px;font-weight:700;color:#0f2445;padding-bottom:4px">Signed</td></tr>
       <tr><td style="font-size:12px;color:#6b7280;padding-bottom:20px">${esc(t.tagline)}</td></tr>`;
  return `<!doctype html><html lang="${o.lang ?? "pt"}"><body style="margin:0;background:#f3f4f6;padding:24px 0">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
  <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:10px;padding:32px;font-family:Segoe UI,Arial,sans-serif;color:#111827;border-top:4px solid ${color}">
    ${head}
    <tr><td style="font-size:18px;font-weight:600;padding-bottom:12px">${esc(title)}</td></tr>
    <tr><td style="font-size:15px;line-height:1.55">${body}${button}</td></tr>
    <tr><td style="font-size:12px;color:#9ca3af;padding-top:28px;border-top:1px solid #e5e7eb">${footer ?? t.footer}</td></tr>
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
  lang?: string | null;
  brand?: Brand | null;
}

export function inviteEmail(d: InviteData): { subject: string; html: string } {
  const t = tx(d.lang);
  const action = d.mode === "qualified" ? (d.step === "fill" ? t.act_fill : t.act_cc) : t.act_sign;
  const subject = `${d.reminder ? t.reminder : ""}${t.invite_subject(d.senderName, action, d.title)}`;
  let body = para(esc(t.hello(d.recipientName))) + para(t.invite_body(esc(d.senderName), esc(d.title), action)) + quote(d.message);
  if (d.mode === "qualified" && d.step === "sign") body += para(t.cc_needs);
  if (d.expiresAt) body += para(esc(t.deadline(formatLisbon(d.expiresAt))));
  return {
    subject,
    html: layout(d.reminder ? t.reminder_title : t.invite_title, body, { label: t.open, url: d.url }, undefined, { lang: d.lang, brand: d.brand }),
  };
}

export function otpEmail(name: string, title: string, code: string, o: { lang?: string | null; brand?: Brand | null } = {}): { subject: string; html: string } {
  const t = tx(o.lang);
  return {
    subject: t.otp_subject(code),
    html: layout(
      t.otp_title,
      para(esc(t.hello(name))) + para(t.otp_use(esc(title))) +
        `<p style="font-size:30px;letter-spacing:8px;font-weight:700;color:${o.brand?.color ?? "#0f2445"};margin:16px 0">${code}</p>` +
        para(t.otp_valid),
      undefined,
      undefined,
      o,
    ),
  };
}

export function completedEmail(
  name: string,
  title: string,
  mode: "simple" | "qualified",
  links: { kind: "doc" | "cert"; url: string }[],
  o: { lang?: string | null; brand?: Brand | null } = {},
): { subject: string; html: string } {
  const t = tx(o.lang);
  const list = links.length
    ? `<ul style="padding-left:18px">${links.map((l) => `<li><a href="${esc(l.url)}">${esc(l.kind === "doc" ? t.doc : t.cert)}</a></li>`).join("")}</ul>` +
      para(`<span style="font-size:12px;color:#6b7280">${t.links_valid}</span>`)
    : para(t.attached);
  const extra = mode === "qualified" ? para(t.cc_validate) : "";
  return {
    subject: t.done_subject(title),
    html: layout(t.done_title, para(esc(t.hello(name))) + para(t.done_body(esc(title))) + extra + list, undefined, undefined, o),
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

export function delegatedEmail(ownerName: string, title: string, from: string, to: string, toEmail: string, reason: string | null, url: string) {
  return {
    subject: `Assinatura delegada: ${title}`,
    html: layout(
      "Uma assinatura foi delegada",
      para(`Olá ${esc(ownerName)},`) +
        para(`<strong>${esc(from)}</strong> passou a assinatura do documento <strong>${esc(title)}</strong> para <strong>${esc(to)}</strong> (${esc(toEmail)}).`) +
        quote(reason) +
        para("O convite já foi enviado à nova pessoa. Se não concordar, pode cancelar o documento ou corrigir o destinatário."),
      { label: "Ver documento", url },
    ),
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
        para("O signatário pode tentar de novo. Se o nome ou o nº de identificação civil estiverem errados, use «Corrigir» no documento para os acertar."),
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
