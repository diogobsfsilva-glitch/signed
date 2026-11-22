// Ações dos colaboradores sobre documentos: enviar, cancelar, lembrar, corrigir.

import { clientIp, handler, HttpError, json, readJson, userAgent } from "../_shared/http.ts";
import { canManage, requireUser } from "../_shared/auth.ts";
import { advance, audit, download, loadBundle, REASSIGNABLE, reassignRecipient, remind, serviceClient, signerToken, tokenHash } from "../_shared/engine.ts";
import { currentRecipients, validateForSend } from "../_shared/workflow.ts";
import { assertValidPdf } from "../_shared/pdf.ts";
import { sha256Hex } from "../_shared/util.ts";

interface Body {
  action: "send" | "cancel" | "remind" | "correct";
  document_id: string;
  recipient_id?: string;
  /** correct: destinatários a corrigir */
  recipients?: { id: string; name?: string; email?: string; civil_id?: string | null }[];
  /** correct: novo prazo (ISO), null para tirar o prazo, ausente para manter */
  expires_at?: string | null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

Deno.serve(handler(async (req) => {
  const sb = serviceClient();
  const user = await requireUser(sb, req);
  const body = await readJson<Body>(req);
  if (!body.document_id) throw new HttpError(400, "Falta o documento.");
  const b = await loadBundle(sb, body.document_id).catch(() => {
    throw new HttpError(404, "Documento não encontrado.");
  });
  const ip = clientIp(req);
  const ua = userAgent(req);

  switch (body.action) {
    case "send": {
      if (b.doc.owner_id !== user.id) throw new HttpError(403, "Só quem criou o documento o pode enviar.");
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
      const bad = b.fields.find((f) => f.page > pages);
      if (bad) throw new HttpError(422, "Há campos em páginas que não existem no PDF.", "validation");
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
        actorUserId: user.id,
        ip,
        ua,
        details: {
          original_sha256: hash,
          mode: b.doc.signature_mode,
          sequential: b.doc.sequential,
          recipients: b.recipients.map((r) => ({ name: r.name, email: r.email, role: r.role, order: r.signing_order })),
        },
      });
      await advance(sb, b.doc.id);
      return json({ ok: true });
    }

    case "cancel": {
      if (!(await canManage(sb, user, b.doc))) throw new HttpError(403, "Sem permissão.");
      if (b.doc.status !== "in_progress") throw new HttpError(409, "Só é possível cancelar documentos em curso.");
      await sb.from("documents").update({ status: "cancelled" }).eq("id", b.doc.id);
      await sb.from("recipients").update({ token_hash: null }).eq("document_id", b.doc.id);
      await audit(sb, b.doc.id, "document.cancelled", { actorUserId: user.id, ip, ua });
      return json({ ok: true });
    }

    case "remind": {
      if (!(await canManage(sb, user, b.doc))) throw new HttpError(403, "Sem permissão.");
      if (b.doc.status !== "in_progress") throw new HttpError(409, "O documento não está em curso.");
      const current = currentRecipients(b.doc, b.recipients, b.fields).map((r) => r.id);
      const targets = b.recipients.filter((r) => current.includes(r.id) && (!body.recipient_id || r.id === body.recipient_id));
      if (!targets.length) throw new HttpError(409, "Não há ninguém a quem lembrar neste momento.");
      for (const r of targets) {
        if (r.reminded_at && Date.now() - new Date(r.reminded_at).getTime() < 10 * 60_000) {
          throw new HttpError(429, `Já foi enviado um lembrete a ${r.name} há menos de 10 minutos.`);
        }
      }
      for (const r of targets) await remind(sb, b, r);
      return json({ ok: true, reminded: targets.length });
    }

    case "correct": {
      if (!(await canManage(sb, user, b.doc))) throw new HttpError(403, "Sem permissão.");
      if (b.doc.status !== "in_progress") throw new HttpError(409, "Só é possível corrigir documentos em curso.");
      const changes: { id: string; from: { name: string; email: string; civil_id: string | null }; to: { name: string; email: string; civil_id: string | null } }[] = [];
      for (const c of body.recipients ?? []) {
        const r = b.recipients.find((x) => x.id === c.id);
        if (!r) throw new HttpError(404, "Destinatário não encontrado.");
        const to = {
          name: (c.name ?? r.name).trim(),
          email: (c.email ?? r.email).trim().toLowerCase(),
          civil_id: c.civil_id === undefined ? r.civil_id : (c.civil_id ?? "").replace(/\D/g, "") || null,
        };
        if (to.name === r.name && to.email === r.email.toLowerCase() && to.civil_id === r.civil_id) continue;
        if (r.role === "signer" && !REASSIGNABLE.includes(r.status)) {
          throw new HttpError(409, `${r.name} já ${r.status === "signed" ? "assinou" : r.status === "filled" ? "preencheu os dados" : "respondeu"} e não pode ser alterado.`);
        }
        if (!to.name || to.name.length > 200) throw new HttpError(422, "Indique o nome.", "validation");
        if (!EMAIL_RE.test(to.email)) throw new HttpError(422, `Email inválido: ${to.email}`, "validation");
        if (to.civil_id && !/^[0-9]{6,9}$/.test(to.civil_id)) throw new HttpError(422, "O nº de identificação civil tem entre 6 e 9 dígitos.", "validation");
        changes.push({ id: r.id, from: { name: r.name, email: r.email, civil_id: r.civil_id }, to });
      }
      const finalEmails = b.recipients.map((r) => changes.find((c) => c.id === r.id)?.to.email ?? r.email.toLowerCase());
      if (new Set(finalEmails).size !== finalEmails.length) throw new HttpError(422, "O mesmo email aparece em dois destinatários.", "validation");

      let expires: { from: string | null; to: string | null } | null = null;
      if (body.expires_at !== undefined) {
        const to = body.expires_at ? new Date(body.expires_at) : null;
        if (to && (isNaN(to.getTime()) || to < new Date(Date.now() + 3600_000))) {
          throw new HttpError(422, "O prazo tem de ser pelo menos daqui a uma hora.", "validation");
        }
        const toIso = to ? to.toISOString() : null;
        if (toIso !== b.doc.expires_at && !(toIso && b.doc.expires_at && new Date(b.doc.expires_at).getTime() === to!.getTime())) {
          expires = { from: b.doc.expires_at, to: toIso };
        }
      }
      if (!changes.length && !expires) throw new HttpError(422, "Não há alterações.", "validation");

      for (const c of changes) await reassignRecipient(sb, b.recipients.find((x) => x.id === c.id)!, c.to);
      if (expires) await sb.from("documents").update({ expires_at: expires.to }).eq("id", b.doc.id);
      await audit(sb, b.doc.id, "document.corrected", {
        actorUserId: user.id,
        ip,
        ua,
        details: { recipients: changes.map((c) => ({ recipient_id: c.id, from: c.from, to: c.to })), expires_at: expires },
      });
      await advance(sb, b.doc.id);
      return json({ ok: true, changed: changes.length });
    }
  }
  throw new HttpError(400, "Ação desconhecida.");
}));
