// Links públicos (formulários reutilizáveis): qualquer pessoa com o link ou o código QR
// cria a sua cópia do modelo, indica o nome e o email e assina.

import { clientIp, handler, HttpError, json, readJson, userAgent } from "../_shared/http.ts";
import { audit, brandFor, BUCKET, createSignerSession, loadBundle, sendDocument, serviceClient, signerToken } from "../_shared/engine.ts";

interface Body {
  action: "info" | "start";
  slug: string;
  name?: string;
  email?: string;
  language?: string;
}

// Por link e por IP. Generoso porque os hóspedes no Wi-Fi do hotel saem todos pelo mesmo IP;
// o limite total do link (max_uses) e a desativação controlam o resto.
const PER_IP_PER_HOUR = 60;
const SESSION_TTL_MS = 4 * 3600_000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const REASONS: Record<string, [number, string, string]> = {
  link_inactive: [404, "Este link não está disponível.", "link_inactive"],
  link_expired: [410, "Este link já expirou.", "link_expired"],
  link_exhausted: [410, "Este link já atingiu o número máximo de utilizações.", "link_exhausted"],
  link_template_invalid: [409, "Este link está mal configurado. Avise o hotel.", "link_invalid"],
  invalid_input: [422, "Indique o nome e um email válido.", "validation"],
};

Deno.serve(handler(async (req) => {
  const body = await readJson<Body>(req);
  const sb = serviceClient();
  const slug = (body.slug ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(slug)) throw new HttpError(404, REASONS.link_inactive[1], "link_inactive");

  const { data: link } = await sb
    .from("public_links")
    .select("id, title, active, require_email_code, max_uses, uses, expires_at, template_id, workspace_id")
    .eq("slug", slug)
    .maybeSingle();
  if (!link || !link.active) throw new HttpError(404, REASONS.link_inactive[1], "link_inactive");
  if (link.expires_at && new Date(link.expires_at) < new Date()) throw new HttpError(410, REASONS.link_expired[1], "link_expired");
  if (link.max_uses && link.uses >= link.max_uses) throw new HttpError(410, REASONS.link_exhausted[1], "link_exhausted");

  switch (body.action) {
    case "info": {
      const { data: tpl } = await sb.from("documents").select("signature_mode, message").eq("id", link.template_id).single();
      const { data: ws } = await sb.from("workspaces").select("name").eq("id", link.workspace_id).single();
      return json({
        title: link.title,
        require_email_code: link.require_email_code,
        mode: tpl?.signature_mode ?? "simple",
        message: tpl?.message ?? null,
        organization: ws?.name ?? null,
        brand: await brandFor(sb, link.workspace_id),
      });
    }

    case "start": {
      const ip = clientIp(req);
      const ua = userAgent(req);
      const name = (body.name ?? "").trim();
      const email = (body.email ?? "").trim().toLowerCase();
      if (!name || name.length > 200 || !EMAIL_RE.test(email)) throw new HttpError(422, REASONS.invalid_input[1], "validation");

      // Limite por link e endereço IP (evita abusos com o link).
      if (ip) {
        const since = new Date(Date.now() - 3600_000).toISOString();
        const { count } = await sb
          .from("audit_events")
          .select("id", { count: "exact", head: true })
          .eq("event", "document.created_from_public_link")
          .eq("ip", ip)
          .filter("details->>link_id", "eq", link.id)
          .gte("created_at", since);
        if ((count ?? 0) >= PER_IP_PER_HOUR) throw new HttpError(429, "Demasiados pedidos a partir desta ligação. Tente mais tarde.", "rate_limited");
      }

      const { data, error } = await sb.rpc("instantiate_public", { p_slug: slug, p_name: name, p_email: email, p_ip: ip });
      if (error) {
        const key = Object.keys(REASONS).find((k) => error.message.includes(k));
        if (key) throw new HttpError(REASONS[key][0], REASONS[key][1], REASONS[key][2]);
        throw error;
      }
      const row = (data as { new_document_id: string; new_original_path: string; template_path: string; recipient_id: string }[])[0];
      if (["en", "es", "fr"].includes(body.language ?? "")) {
        await sb.from("recipients").update({ language: body.language }).eq("id", row.recipient_id);
      }
      const cp = await sb.storage.from(BUCKET).copy(row.template_path, row.new_original_path);
      if (cp.error) throw new Error(`Cópia do PDF: ${cp.error.message}`);
      await sendDocument(sb, await loadBundle(sb, row.new_document_id), { ip, ua });

      const token = await signerToken({ id: row.recipient_id, token_version: 0 });
      if (link.require_email_code) return json({ token });
      // Sem código: a pessoa está a preencher o formulário e abre já o documento
      // (também recebe o link por email para voltar mais tarde).
      const session = await createSignerSession(sb, row.recipient_id, SESSION_TTL_MS);
      await audit(sb, row.new_document_id, "recipient.public_access", { recipientId: row.recipient_id, ip, ua });
      return json({ token, session });
    }
  }
  throw new HttpError(400, "Ação desconhecida.");
}));
