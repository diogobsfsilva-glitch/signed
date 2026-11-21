import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase, BUCKET } from "../lib/supabase";
import { documentAction } from "../lib/api";
import { instantiate } from "../lib/templates";
import type { AuditEventRow, DocumentRow, RecipientRow } from "../../supabase/functions/_shared/types";
import { EVENT_LABELS } from "../../supabase/functions/_shared/types";
import { Alert, CheckIcon, DownloadIcon, FullPageSpinner, IdIcon, ModeBadge, RecipientBadge, ShieldIcon, StatusBadge, toast } from "../components/ui";
import { PdfPages } from "../components/PdfPages";
import { errorMessage, fmtDateTime } from "../lib/format";
import { useAuth } from "../auth/AuthProvider";

// O token do link nunca é lido pelo cliente (sem permissão nessa coluna).
const RECIPIENT_COLUMNS =
  "id, document_id, name, email, role, signing_order, civil_id, color, status, notified_at, viewed_at, filled_at, signed_at, declined_at, decline_reason, sign_ip, sign_user_agent, cert_subject, cert_issuer, cert_serial, cert_serial_number_attr, created_at";

interface EmailRow {
  id: number;
  to_email: string;
  subject: string;
  kind: string;
  status: string;
  error: string | null;
  created_at: string;
}

export function DocumentDetail() {
  const { id } = useParams();
  const { profile } = useAuth();
  const nav = useNavigate();
  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [events, setEvents] = useState<AuditEventRow[]>([]);
  const [emails, setEmails] = useState<EmailRow[]>([]);
  // Modo de teste: texto dos emails não enviados (link e código), para reencaminhar à mão.
  const [bodies, setBodies] = useState<Map<number, string>>(new Map());
  const [chainOk, setChainOk] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"history" | "emails">("history");
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    const { data: d } = await supabase.from("documents").select("*").eq("id", id!).maybeSingle();
    if (!d) return setMissing(true);
    const [{ data: r }, { data: ev }, { data: em }, { data: ok }, { data: tb }] = await Promise.all([
      supabase.from("recipients").select(RECIPIENT_COLUMNS).eq("document_id", d.id).order("signing_order").order("created_at"),
      supabase.from("audit_events").select("*").eq("document_id", d.id).order("id"),
      supabase.from("email_log").select("id, to_email, subject, kind, status, error, created_at").eq("document_id", d.id).order("id", { ascending: false }),
      supabase.rpc("verify_audit_chain", { p_document_id: d.id }),
      supabase.rpc("test_email_bodies", { p_document_id: d.id }),
    ]);
    setBodies(new Map(((tb as { id: number; body_text: string | null }[] | null) ?? []).filter((x) => x.body_text).map((x) => [x.id, x.body_text!])));
    setDoc(d);
    setRecipients((r as unknown as RecipientRow[]) ?? []);
    setEvents(ev ?? []);
    setEmails(em ?? []);
    setChainOk(ok ?? null);
    const path = d.final_path ?? d.current_path ?? d.original_path;
    if (path) {
      const { data: u } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
      setPreview((prev) => (prev && prev.split("?")[0] === u?.signedUrl.split("?")[0] ? prev : (u?.signedUrl ?? null)));
    }
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function download(path: string | null, name: string) {
    if (!path) return;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 120, { download: name });
    if (error) return toast(errorMessage(error), "error");
    window.location.href = data.signedUrl;
  }

  async function act(action: "cancel" | "remind", rid?: string) {
    if (action === "cancel" && !confirm("Cancelar o documento? Os links deixam de funcionar.")) return;
    setBusy(true);
    try {
      await documentAction(action, doc!.id, rid);
      toast(action === "cancel" ? "Documento cancelado." : "Lembrete enviado.");
      load();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  if (missing) return <div className="p-8"><Alert>Documento não encontrado ou sem acesso.</Alert></div>;
  if (!doc) return <FullPageSpinner />;

  const base = doc.title.replace(/[^\w\- À-ÿ]+/g, "").trim().replace(/\s+/g, "_") || "documento";
  const names = new Map(recipients.map((r) => [r.id, r.name]));
  const signers = recipients.filter((r) => r.role === "signer");
  const signed = signers.filter((r) => r.status === "signed").length;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
      <Link to="/" className="text-sm text-slate-500 hover:text-slate-800">← Documentos</Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{doc.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <StatusBadge status={doc.status} />
            <ModeBadge mode={doc.signature_mode} />
            <span>Enviado {fmtDateTime(doc.sent_at)}</span>
            {doc.expires_at && doc.status === "in_progress" && <span>· prazo {fmtDateTime(doc.expires_at)}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {doc.status === "completed" && (
            <>
              <button className="btn-primary" onClick={() => download(doc.final_path, `${base}${doc.signature_mode === "qualified" ? "_assinado" : ""}.pdf`)}>
                <DownloadIcon className="h-4 w-4" /> Documento assinado
              </button>
              <button className="btn-secondary" onClick={() => download(doc.audit_path, `${base}_certificado.pdf`)}>
                <ShieldIcon className="h-4 w-4" /> Certificado
              </button>
            </>
          )}
          {doc.status === "in_progress" && (
            <>
              <button className="btn-secondary" disabled={busy} onClick={() => act("remind")}>Enviar lembrete</button>
              <button className="btn-danger" disabled={busy} onClick={() => act("cancel")}>Cancelar</button>
            </>
          )}
          <button className="btn-ghost" onClick={() => download(doc.original_path, `${base}_original.pdf`)}>Original</button>
          {doc.original_path && (
            <button
              className="btn-ghost"
              disabled={busy}
              onClick={async () => {
                const name = prompt("Nome do modelo (usa o PDF original, os destinatários e os campos deste documento):", doc.title);
                if (!name?.trim()) return;
                setBusy(true);
                try {
                  const tid = await instantiate({ sourceId: doc.id, sourcePath: doc.original_path!, asTemplate: true, title: name.trim(), workspaceId: doc.workspace_id });
                  toast("Modelo criado. Ajuste os papéis (ex.: Colaborador) e conclua.");
                  nav(`/documentos/${tid}/editar`);
                } catch (e) {
                  toast(errorMessage(e), "error");
                  setBusy(false);
                }
              }}
            >
              Guardar como modelo
            </button>
          )}
        </div>
      </div>

      {doc.archive_url && (
        <p className="mt-3 text-sm text-slate-600">
          Arquivado no SharePoint: <a className="text-navy-600 underline" href={doc.archive_url} target="_blank" rel="noreferrer">abrir pasta</a>
        </p>
      )}
      {doc.archive_error && profile?.role === "admin" && <div className="mt-3"><Alert kind="warning">Falha ao arquivar no SharePoint: {doc.archive_error}</Alert></div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="order-2 min-w-0 lg:order-1">
          <div className="rounded-xl bg-slate-100 p-3 sm:p-6">
            <PdfPages src={preview} />
          </div>
        </div>

        <div className="order-1 space-y-6 lg:order-2">
          <section className="card p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Destinatários</h2>
              {signers.length > 0 && <span className="text-sm text-slate-500">{signed}/{signers.length} assinaram</span>}
            </div>
            {signers.length > 0 && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(signed / signers.length) * 100}%` }} />
              </div>
            )}
            {doc.signature_mode === "qualified" && doc.status === "in_progress" && (
              <p className="mt-3 text-xs text-slate-500">
                Fase atual: <strong>{doc.phase === "fill" ? "preenchimento dos campos" : "assinatura com Cartão de Cidadão"}</strong>
              </p>
            )}
            <ol className="mt-3 space-y-3">
              {recipients.map((r) => (
                <li key={r.id} className="flex gap-3">
                  <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{r.name}</p>
                      {r.role === "signer" ? <RecipientBadge status={r.status} /> : <span className="text-xs text-slate-400">cópia</span>}
                    </div>
                    <p className="truncate text-xs text-slate-500">{r.email}</p>
                    {r.signed_at && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700">
                        <CheckIcon className="h-3.5 w-3.5" /> {fmtDateTime(r.signed_at)}{r.sign_ip ? ` · IP ${r.sign_ip}` : ""}
                      </p>
                    )}
                    {r.cert_subject && (
                      <p className="mt-1 flex items-start gap-1 text-xs text-slate-600">
                        <IdIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="break-words">{r.cert_subject.match(/CN=([^,]+)/)?.[1]} · {r.cert_issuer?.match(/CN=([^,]+)/)?.[1]}</span>
                      </p>
                    )}
                    {r.decline_reason && <p className="mt-1 text-xs text-red-700">Motivo: {r.decline_reason}</p>}
                    {doc.status === "in_progress" && r.role === "signer" && !["signed", "declined", "pending"].includes(r.status) && (
                      <button className="mt-1 text-xs text-navy-600 hover:underline" disabled={busy} onClick={() => act("remind", r.id)}>Lembrar</button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="card p-4">
            <div className="flex gap-4 border-b border-slate-100 text-sm">
              <button className={`-mb-px border-b-2 pb-2 font-medium ${tab === "history" ? "border-navy-900" : "border-transparent text-slate-500"}`} onClick={() => setTab("history")}>Histórico</button>
              <button className={`-mb-px border-b-2 pb-2 font-medium ${tab === "emails" ? "border-navy-900" : "border-transparent text-slate-500"}`} onClick={() => setTab("emails")}>Emails ({emails.length})</button>
            </div>
            {tab === "history" ? (
              <>
                <p className={`mt-3 flex items-center gap-1.5 text-xs ${chainOk === false ? "text-red-700" : "text-emerald-700"}`}>
                  <ShieldIcon className="h-4 w-4" />
                  {chainOk === false ? "Atenção: o registo de auditoria não confere." : "Registo de auditoria íntegro."}
                </p>
                <ol className="mt-3 space-y-2.5">
                  {[...events].reverse().map((e) => (
                    <li key={e.id} className="text-sm">
                      <p className="text-slate-800">
                        {EVENT_LABELS[e.event] ?? e.event}
                        {e.recipient_id && <span className="text-slate-500"> — {names.get(e.recipient_id)}</span>}
                      </p>
                      <p className="text-xs text-slate-400">
                        {fmtDateTime(e.created_at)}{e.ip ? ` · ${e.ip}` : ""}
                        {e.event === "recipient.cc_rejected" && typeof e.details.reason === "string" ? ` · ${e.details.reason}` : ""}
                      </p>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <ul className="mt-3 space-y-2.5">
                {emails.map((m) => (
                  <li key={m.id} className="text-sm">
                    <p className="truncate text-slate-800">{m.subject}</p>
                    <p className="text-xs text-slate-400">
                      {m.to_email} · {fmtDateTime(m.created_at)} ·{" "}
                      <span className={m.status === "failed" ? "text-red-700" : m.status === "skipped" ? "text-amber-700" : "text-emerald-700"}>
                        {m.status === "sent" ? "enviado" : m.status === "skipped" ? "não enviado (email desligado)" : "falhou"}
                      </span>
                    </p>
                    {m.error && <p className="text-xs text-red-700">{m.error.slice(0, 200)}</p>}
                    {bodies.has(m.id) && <TestEmailBody text={bodies.get(m.id)!} />}
                  </li>
                ))}
                {emails.length === 0 && <li className="muted">Sem emails.</li>}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** Modo de teste: mostra o link e o código de um email que não foi enviado, para reencaminhar à mão. */
function TestEmailBody({ text }: { text: string }) {
  const link = /https?:\/\/\S+\/s\/[A-Za-z0-9_-]+/.exec(text)?.[0];
  const code = /^\s*(\d{6})\s*$/m.exec(text)?.[1];
  return (
    <div className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
      {code && (
        <p>
          Código: <span className="select-all font-mono text-sm font-semibold tracking-widest">{code}</span>
        </p>
      )}
      {link && (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono">{link}</span>
          <button
            className="shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 font-medium hover:bg-amber-100"
            onClick={() => navigator.clipboard.writeText(link).then(() => toast("Link copiado."))}
          >
            Copiar link
          </button>
        </div>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer text-amber-700">Ver email completo</summary>
        <p className="mt-1 whitespace-pre-wrap text-slate-700">{text}</p>
      </details>
    </div>
  );
}
