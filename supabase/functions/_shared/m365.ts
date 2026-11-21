// Microsoft 365 (Graph): envio de emails, arquivo no SharePoint e conversão Word -> PDF.
// Usa uma aplicação registada no Entra ID da Altis com permissões de aplicação
// Mail.Send (limitada à caixa do remetente) e Sites.Selected (limitada ao site de arquivo).

import { toArrayBuffer, toBase64 } from "./util.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

export interface M365Config {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  sender: string;
  siteId: string | null;
  archiveFolder: string;
}

export function m365Config(): M365Config | null {
  const tenantId = Deno.env.get("M365_TENANT_ID");
  const clientId = Deno.env.get("M365_CLIENT_ID");
  const clientSecret = Deno.env.get("M365_CLIENT_SECRET");
  const sender = Deno.env.get("M365_SENDER");
  if (!tenantId || !clientId || !clientSecret || !sender) return null;
  return {
    tenantId,
    clientId,
    clientSecret,
    sender,
    siteId: Deno.env.get("M365_SHAREPOINT_SITE_ID") || null,
    archiveFolder: Deno.env.get("M365_ARCHIVE_FOLDER") || "Signed",
  };
}

let cached: { token: string; exp: number } | null = null;

async function token(cfg: M365Config): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Microsoft 365: falha na autenticação (${res.status}) ${await res.text()}`);
  const j = await res.json();
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

async function graph(cfg: M365Config, path: string, init: RequestInit = {}): Promise<Response> {
  const t = await token(cfg);
  const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${t}`, ...(init.headers ?? {}) },
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`Microsoft 365: ${init.method ?? "GET"} ${path} -> ${res.status} ${(await res.text()).slice(0, 500)}`);
  }
  return res;
}

export interface MailAttachment {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export async function sendMail(
  cfg: M365Config,
  msg: { to: string; subject: string; html: string; attachments?: MailAttachment[] },
): Promise<void> {
  await graph(cfg, `/users/${encodeURIComponent(cfg.sender)}/sendMail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: msg.subject,
        body: { contentType: "HTML", content: msg.html },
        toRecipients: [{ emailAddress: { address: msg.to } }],
        attachments: (msg.attachments ?? []).map((a) => ({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: a.name,
          contentType: a.contentType,
          contentBytes: toBase64(a.bytes),
        })),
      },
      saveToSentItems: false,
    }),
  });
}

function drivePath(cfg: M365Config, path: string): string {
  const enc = path.split("/").map(encodeURIComponent).join("/");
  return `/sites/${cfg.siteId}/drive/root:/${enc}`;
}

/** Carrega um ficheiro para o SharePoint (sessão de upload, suporta ficheiros grandes). Devolve o URL web. */
export async function uploadToSharePoint(cfg: M365Config, path: string, bytes: Uint8Array): Promise<string> {
  if (!cfg.siteId) throw new Error("M365_SHAREPOINT_SITE_ID não configurado");
  const session = await graph(cfg, `${drivePath(cfg, path)}:/createUploadSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
  }).then((r) => r.json());
  const chunk = 5 * 1024 * 1024; // múltiplo de 320 KiB
  let last: { webUrl?: string } = {};
  for (let start = 0; start < bytes.length; start += chunk) {
    const end = Math.min(start + chunk, bytes.length);
    const res = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: { "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}`, "Content-Length": String(end - start) },
      body: toArrayBuffer(bytes.subarray(start, end)),
    });
    if (!res.ok) throw new Error(`SharePoint: upload falhou (${res.status}) ${(await res.text()).slice(0, 300)}`);
    if (res.status === 200 || res.status === 201) last = await res.json();
  }
  return last.webUrl ?? "";
}

/** Converte .docx em PDF usando o próprio Microsoft 365 (ficheiro temporário no SharePoint). */
export async function convertDocxToPdf(cfg: M365Config, docx: Uint8Array, name: string): Promise<Uint8Array> {
  if (!cfg.siteId) throw new Error("A conversão de Word requer M365_SHAREPOINT_SITE_ID");
  const tmp = `${cfg.archiveFolder}/_conversao/${crypto.randomUUID()}-${name.replace(/[^\w.-]+/g, "_")}`;
  const item = await graph(cfg, `${drivePath(cfg, tmp)}:/content`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: toArrayBuffer(docx),
  }).then((r) => r.json());
  try {
    const res = await graph(cfg, `/sites/${cfg.siteId}/drive/items/${item.id}/content?format=pdf`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    await graph(cfg, `/sites/${cfg.siteId}/drive/items/${item.id}`, { method: "DELETE" }).catch(() => {});
  }
}
