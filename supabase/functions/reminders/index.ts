// Agendador (chamado de hora a hora pelo pg_cron): expira documentos, envia lembretes
// e retoma documentos que tenham ficado a meio de uma transição.

import { handler, HttpError, json } from "../_shared/http.ts";
import { advance, appUrl, audit, loadBundle, remind, sendDocument, serviceClient, withDocLock } from "../_shared/engine.ts";
import { type DigestItem, deliver, digestEmail, expiredEmail, renewalEmail, scheduleFailedEmail } from "../_shared/email.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { currentRecipients } from "../_shared/workflow.ts";

Deno.serve(handler(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) throw new HttpError(401, "Não autorizado");
  const sb = serviceClient();
  const now = Date.now();
  const stats = { expired: 0, reminded: 0, resumed: 0, errors: 0, scheduled: 0, renewals: 0, digests: 0 };

  // Envios agendados que chegaram à hora.
  try {
    stats.scheduled = await sendScheduled(sb);
  } catch (e) {
    stats.errors++;
    console.error("reminders: agendados", e);
  }

  // Os mais antigos primeiro; acima de 1000 em curso, o resto é tratado na hora seguinte.
  const { data: docs } = await sb.from("documents").select("id").eq("status", "in_progress").order("sent_at").limit(1000);
  for (const { id } of docs ?? []) {
    try {
      const b = await loadBundle(sb, id);
      if (b.doc.expires_at && new Date(b.doc.expires_at).getTime() < now) {
        // Com o trinco: não expira um documento que está a ser concluído nesse instante.
        const expired = await withDocLock(sb, id, async () => {
          const { data } = await sb.from("documents").update({ status: "expired" }).eq("id", id).eq("status", "in_progress").select("id");
          if (!data?.length) return false;
          await sb.from("recipients").update({ token_hash: null }).eq("document_id", id);
          await audit(sb, id, "document.expired");
          return true;
        });
        if (expired) {
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
  try {
    stats.renewals = await renewalAlerts(sb);
  } catch (e) {
    stats.errors++;
    console.error("reminders: renovações", e);
  }
  try {
    stats.digests = await weeklyDigest(sb);
  } catch (e) {
    stats.errors++;
    console.error("reminders: resumo semanal", e);
  }

  // Limpeza de sessões e códigos expirados.
  await sb.from("signer_sessions").delete().lt("expires_at", new Date().toISOString());
  await sb.from("signer_otps").delete().lt("expires_at", new Date(now - 86_400_000).toISOString());
  return json(stats);
}));

const TZ = "Europe/Lisbon";
/** Data de hoje em Lisboa (AAAA-MM-DD). */
function todayLisbon(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
const ptDate = (iso: string) => iso.split("-").reverse().join("/");

/** Rascunhos com envio agendado para agora (ou antes): envia em nome do dono. */
async function sendScheduled(sb: SupabaseClient): Promise<number> {
  const { data } = await sb.from("documents").select("id").eq("status", "draft").not("scheduled_at", "is", null)
    .lte("scheduled_at", new Date().toISOString()).limit(200);
  let n = 0;
  for (const { id } of data ?? []) {
    const b = await loadBundle(sb, id);
    // Primeiro tira o agendamento: uma falha não se repete de hora a hora.
    await sb.from("documents").update({ scheduled_at: null }).eq("id", id);
    try {
      await sendDocument(sb, b, { actorUserId: b.doc.owner_id });
      await audit(sb, id, "document.scheduled_sent", { details: { scheduled_at: b.doc.scheduled_at } });
      n++;
    } catch (e) {
      const reason = String((e as Error).message ?? e).slice(0, 1000);
      await audit(sb, id, "document.schedule_failed", { details: { reason } });
      const mail = scheduleFailedEmail(b.owner.full_name || b.owner.email, b.doc.title, reason, `${appUrl()}/documentos/${id}/editar`);
      await deliver(sb, { to: b.owner.email, subject: mail.subject, html: mail.html, kind: "schedule_failed", documentId: id });
    }
  }
  return n;
}

/** Contratos concluídos a chegar ao fim: um email ao remetente, uma vez por data. */
async function renewalAlerts(sb: SupabaseClient): Promise<number> {
  const today = todayLisbon();
  const { data } = await sb
    .from("documents")
    .select("id, title, contract_end, renewal_notice_days, owner:profiles!documents_owner_id_fkey(email, full_name, active)")
    .eq("status", "completed")
    .not("contract_end", "is", null)
    .is("renewal_notified_at", null)
    .order("contract_end")
    .limit(500);
  let n = 0;
  for (const d of (data ?? []) as unknown as { id: string; title: string; contract_end: string; renewal_notice_days: number; owner: { email: string; full_name: string | null; active: boolean } }[]) {
    const left = daysBetween(today, d.contract_end);
    if (left > d.renewal_notice_days || !d.owner?.active) continue;
    const mail = renewalEmail(d.owner.full_name || d.owner.email, d.title, ptDate(d.contract_end), left, `${appUrl()}/documentos/${d.id}`);
    await deliver(sb, { to: d.owner.email, subject: mail.subject, html: mail.html, kind: "renewal", documentId: d.id });
    await sb.from("documents").update({ renewal_notified_at: new Date().toISOString() }).eq("id", d.id);
    await audit(sb, d.id, "document.renewal_alert", { details: { contract_end: d.contract_end, days_left: left } });
    n++;
  }
  return n;
}

/** Resumo semanal: à segunda-feira a partir das 8h (Lisboa), uma vez por semana e por pessoa. */
async function weeklyDigest(sb: SupabaseClient): Promise<number> {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  if (parts.weekday !== "Mon" || Number(parts.hour) < 8) return 0;
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
  const { data: people } = await sb
    .from("profiles")
    .select("id, email, full_name")
    .eq("active", true)
    .eq("weekly_digest", true)
    .or(`digest_sent_at.is.null,digest_sent_at.lt.${weekAgo}`)
    .limit(1000);
  const today = todayLisbon();
  let n = 0;
  for (const p of people ?? []) {
    // Marca primeiro: se algo falhar, não se repete na hora seguinte.
    await sb.from("profiles").update({ digest_sent_at: new Date().toISOString() }).eq("id", p.id);
    const [{ data: open }, { data: ending }] = await Promise.all([
      sb.from("documents").select("id, title, sent_at, recipients(name, role, status, signing_order)").eq("owner_id", p.id).eq("status", "in_progress").order("sent_at").limit(200),
      sb.from("documents").select("id, title, contract_end").eq("owner_id", p.id).eq("status", "completed")
        .gte("contract_end", today).lte("contract_end", new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)).order("contract_end").limit(50),
    ]);
    if (!open?.length && !ending?.length) continue;
    const items: DigestItem[] = (open ?? []).map((d) => {
      const rs = (d.recipients as { name: string; role: string; status: string; signing_order: number }[])
        .filter((r) => r.role === "signer" && r.status !== "signed" && r.status !== "declined")
        .sort((a, b) => a.signing_order - b.signing_order);
      return {
        title: d.title,
        url: `${appUrl()}/documentos/${d.id}`,
        waiting: rs.map((r) => r.name).slice(0, 3).join(", ") + (rs.length > 3 ? ` e mais ${rs.length - 3}` : ""),
        days: Math.max(0, Math.floor((Date.now() - new Date(d.sent_at!).getTime()) / 86_400_000)),
      };
    });
    const expiring: DigestItem[] = (ending ?? []).map((d) => ({
      title: d.title,
      url: `${appUrl()}/documentos/${d.id}`,
      waiting: `Termina a ${ptDate(d.contract_end!)}`,
      days: 0,
    }));
    if (!items.length && !expiring.length) continue;
    const mail = digestEmail(p.full_name || p.email, items, expiring, appUrl());
    await deliver(sb, { to: p.email, subject: mail.subject, html: mail.html, kind: "digest" });
    n++;
  }
  return n;
}
