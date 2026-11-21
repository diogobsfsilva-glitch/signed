// Agendador (chamado de hora a hora pelo pg_cron): expira documentos, envia lembretes
// e retoma documentos que tenham ficado a meio de uma transição.

import { handler, HttpError, json } from "../_shared/http.ts";
import { advance, appUrl, audit, loadBundle, remind, serviceClient } from "../_shared/engine.ts";
import { deliver, expiredEmail } from "../_shared/email.ts";
import { currentRecipients } from "../_shared/workflow.ts";

Deno.serve(handler(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) throw new HttpError(401, "Não autorizado");
  const sb = serviceClient();
  const now = Date.now();
  const stats = { expired: 0, reminded: 0, resumed: 0, errors: 0 };

  const { data: docs } = await sb.from("documents").select("id").eq("status", "in_progress").limit(500);
  for (const { id } of docs ?? []) {
    try {
      const b = await loadBundle(sb, id);
      if (b.doc.expires_at && new Date(b.doc.expires_at).getTime() < now) {
        const { data } = await sb.from("documents").update({ status: "expired" }).eq("id", id).eq("status", "in_progress").select("id");
        if (data?.length) {
          await sb.from("recipients").update({ token_hash: null }).eq("document_id", id);
          await audit(sb, id, "document.expired");
          const mail = expiredEmail(b.owner.full_name || b.owner.email, b.doc.title, `${appUrl()}/documentos/${id}`);
          await deliver(sb, { to: b.owner.email, subject: mail.subject, html: mail.html, kind: "expired", documentId: id });
          stats.expired++;
        }
        continue;
      }
      // Retoma transições pendentes (ex.: falha a meio da conclusão).
      const current = currentRecipients(b.doc, b.recipients, b.fields);
      const needsAdvance =
        current.length === 0 ||
        current.some((r) => r.notified_phase !== b.doc.phase) ||
        (b.doc.signature_mode === "qualified" && b.doc.phase === "sign" && !b.doc.prepared_path);
      if (needsAdvance) {
        await advance(sb, id);
        stats.resumed++;
        continue;
      }
      if (b.doc.reminder_days > 0) {
        for (const r of current) {
          const last = new Date(r.reminded_at ?? r.notified_at ?? b.doc.sent_at!).getTime();
          if (now - last >= b.doc.reminder_days * 86_400_000) {
            await remind(sb, b, r);
            stats.reminded++;
          }
        }
      }
    } catch (e) {
      stats.errors++;
      console.error(`reminders: ${id}`, e);
    }
  }
  // Limpeza de sessões e códigos expirados.
  await sb.from("signer_sessions").delete().lt("expires_at", new Date().toISOString());
  await sb.from("signer_otps").delete().lt("expires_at", new Date(now - 86_400_000).toISOString());
  return json(stats);
}));
