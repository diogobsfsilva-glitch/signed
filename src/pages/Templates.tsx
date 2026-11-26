import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { instantiate } from "../lib/templates";
import { CreateLinkModal, linkProblem, QrModal, type LinkRow } from "./PublicLinks";
import { Alert, EmptyState, FullPageSpinner, IdIcon, ModeBadge, Modal, PlusIcon, Spinner, toast } from "../components/ui";
import { errorMessage, relative } from "../lib/format";

interface TRecipient {
  id: string;
  name: string;
  email: string;
  role: "signer" | "cc";
  signing_order: number;
  civil_id: string | null;
  color: string;
  group_emails: string[] | null;
}

export interface TemplateRow {
  id: string;
  title: string;
  signature_mode: "simple" | "qualified";
  parts: { name: string; pages: number }[] | null;
  updated_at: string;
  owner_id: string;
  workspace_id: string;
  original_path: string | null;
  recipients: TRecipient[];
  fields: { count: number }[];
  owner: { full_name: string | null; email: string } | null;
}

export function Templates() {
  const { profile, workspaces } = useAuth();
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [q, setQ] = useState("");
  const [using, setUsing] = useState<TemplateRow | null>(null);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [qr, setQr] = useState<LinkRow | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    supabase
      .from("documents")
      .select(
        "id, title, signature_mode, parts, updated_at, owner_id, workspace_id, original_path, recipients(id, name, email, role, signing_order, civil_id, color, group_emails), fields(count), owner:profiles!documents_owner_id_fkey(full_name, email)",
      )
      .eq("is_template", true)
      .order("title")
      .then(({ data, error }) => {
        if (error) toast(errorMessage(error), "error");
        setRows((data as unknown as TemplateRow[]) ?? []);
      });
  }, []);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => !t || r.title.toLowerCase().includes(t));
  }, [rows, q]);

  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name;
  const canEdit = (r: TemplateRow) =>
    r.owner_id === profile?.id || profile?.role === "admin" || workspaces.find((w) => w.id === r.workspace_id)?.myRole === "admin";

  if (!rows) return <FullPageSpinner />;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Modelos</h1>
          <p className="muted mt-0.5">Documentos prontos a usar: o PDF, quem assina e os campos já estão definidos.</p>
        </div>
        <Link to="/novo?modelo=1" className="btn-primary">
          <PlusIcon className="h-4 w-4" /> Novo modelo
        </Link>
      </div>

      {rows.length > 0 && (
        <input className="input mt-6 sm:max-w-72" placeholder="Pesquisar modelo" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Pesquisar" />
      )}

      <div className="mt-4">
        {filtered.length === 0 ? (
          <EmptyState
            title={rows.length === 0 ? "Ainda não há modelos" : "Nenhum modelo encontrado"}
            action={rows.length === 0 && <Link to="/novo?modelo=1" className="btn-primary">Criar o primeiro modelo</Link>}
          >
            {rows.length === 0
              ? "Crie um modelo para contratos que se repetem (contratos de trabalho, acordos com fornecedores, termos de responsabilidade). Também pode guardar como modelo qualquer documento já enviado."
              : "Experimente outra pesquisa."}
          </EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((r) => {
              const signers = r.recipients.filter((x) => x.role === "signer").sort((a, b) => a.signing_order - b.signing_order);
              return (
                <li key={r.id} className="card flex flex-col p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 font-medium text-slate-900">{r.title}</p>
                    {r.parts && r.parts.length > 1 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600" title={r.parts.map((p) => p.name).join("\n")}>Pacote · {r.parts.length}</span>}
                    <ModeBadge mode={r.signature_mode} />
                  </div>
                  <p className="mt-1 text-sm text-slate-500">
                    {signers.length ? signers.map((s) => s.name).join(" → ") : "Sem signatários"}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {r.fields[0]?.count ?? 0} campos
                    {workspaces.length > 1 && wsName(r.workspace_id) ? ` · ${wsName(r.workspace_id)}` : ""}
                    {r.owner && r.owner_id !== profile?.id ? ` · de ${r.owner.full_name ?? r.owner.email}` : ""} · {relative(r.updated_at)}
                  </p>
                  <div className="mt-4 flex gap-2 pt-1">
                    <button className="btn-primary flex-1" onClick={() => setUsing(r)} disabled={!r.original_path || signers.length === 0}>
                      Usar
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => nav(`/modelos/${r.id}/envio-em-massa`)}
                      disabled={!r.original_path || signers.length === 0}
                      title="Enviar a muitas pessoas a partir de um ficheiro CSV"
                    >
                      Em massa
                    </button>
                    {!linkProblem(r) && (
                      <button className="btn-secondary" onClick={() => setLinkFor(r.id)} title="Link ou código QR para qualquer pessoa preencher e assinar">
                        Link
                      </button>
                    )}
                    {canEdit(r) && (
                      <button className="btn-secondary" onClick={() => nav(`/documentos/${r.id}/editar`)}>
                        Editar
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <UseTemplateModal template={using} onClose={() => setUsing(null)} />
      <CreateLinkModal open={!!linkFor} templateId={linkFor ?? undefined} onClose={() => setLinkFor(null)} onCreated={(l) => { setLinkFor(null); setQr(l); }} />
      <QrModal link={qr} onClose={() => setQr(null)} />
    </div>
  );
}

export function UseTemplateModal({ template, onClose }: { template: TemplateRow | null; onClose: () => void }) {
  const { workspaces } = useAuth();
  const nav = useNavigate();
  const [title, setTitle] = useState("");
  const [ws, setWs] = useState("");
  const [values, setValues] = useState<Record<string, { name: string; email: string; civil_id: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!template) return;
    setTitle(template.title);
    setWs(workspaces.some((w) => w.id === template.workspace_id) ? template.workspace_id : workspaces[0]?.id ?? "");
    setValues(
      Object.fromEntries(
        template.recipients.map((r) => [r.id, { name: r.email ? r.name : "", email: r.email, civil_id: r.civil_id ?? "" }]),
      ),
    );
    setError(null);
    setBusy(false);
  }, [template, workspaces]);

  if (!template) return null;
  const ordered = [...template.recipients].sort((a, b) => a.signing_order - b.signing_order);
  const q = template.signature_mode === "qualified";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!template) return;
    setError(null);
    const seen = new Set<string>();
    for (const r of ordered) {
      if (r.group_emails?.length) continue; // grupo fixo do modelo
      const v = values[r.id];
      const email = v.email.trim().toLowerCase();
      if (!v.name.trim()) return setError(`Indique o nome para "${r.name}".`);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setError(`Email inválido para "${r.name}".`);
      if (seen.has(email)) return setError(`O email ${email} aparece repetido.`);
      seen.add(email);
      const c = v.civil_id.replace(/\D/g, "");
      if (c && (c.length < 6 || c.length > 9)) return setError("O nº de identificação civil tem entre 6 e 9 dígitos.");
    }
    setBusy(true);
    try {
      const id = await instantiate({
        sourceId: template.id,
        sourcePath: template.original_path!,
        asTemplate: false,
        title,
        workspaceId: ws,
        recipients: ordered.filter((r) => !r.group_emails?.length).map((r) => ({
          id: r.id,
          name: values[r.id].name.trim(),
          email: values[r.id].email.trim().toLowerCase(),
          civil_id: values[r.id].civil_id.replace(/\D/g, "") || null,
        })),
      });
      nav(`/documentos/${id}/editar?rever=1`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Usar modelo: ${template.title}`} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={workspaces.length > 1 ? "" : "sm:col-span-2"}>
            <label className="label" htmlFor="ut-title">Título do documento</label>
            <input id="ut-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
          </div>
          {workspaces.length > 1 && (
            <div>
              <label className="label" htmlFor="ut-ws">Espaço de trabalho</label>
              <select id="ut-ws" className="input" value={ws} onChange={(e) => setWs(e.target.value)}>
                {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          )}
        </div>

        <div>
          <p className="label">Destinatários</p>
          <ol className="space-y-2.5">
            {ordered.map((r, i) => (
              <li key={r.id} className="rounded-lg border border-slate-200 p-3">
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: r.color }}>
                    {i + 1}
                  </span>
                  <span className="font-medium">{r.name}</span>
                  <span className="text-xs text-slate-500">{r.role === "signer" ? "assina" : "recebe cópia"}</span>
                </div>
                {r.group_emails?.length ? (
                  <p className="text-xs text-slate-500">Grupo de assinatura: {r.group_emails.join(", ")}</p>
                ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <input
                    className="input"
                    placeholder="Nome completo"
                    value={values[r.id]?.name ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [r.id]: { ...v[r.id], name: e.target.value } }))}
                    maxLength={200}
                    required
                    aria-label={`Nome de ${r.name}`}
                  />
                  <input
                    className="input"
                    type="email"
                    placeholder="email@exemplo.pt"
                    value={values[r.id]?.email ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [r.id]: { ...v[r.id], email: e.target.value } }))}
                    required
                    aria-label={`Email de ${r.name}`}
                  />
                  {q && r.role === "signer" && (
                    <input
                      className="input sm:col-span-2"
                      placeholder="Nº de identificação civil (opcional)"
                      inputMode="numeric"
                      value={values[r.id]?.civil_id ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [r.id]: { ...v[r.id], civil_id: e.target.value } }))}
                      aria-label={`Nº de identificação civil de ${r.name}`}
                    />
                  )}
                </div>
                )}
              </li>
            ))}
          </ol>
          {q && (
            <p className="mt-2 text-xs text-slate-500">
              <IdIcon className="mr-1 inline h-3.5 w-3.5" />
              Modo Cartão de Cidadão: o nome tem de corresponder ao do cartão (ou indique o nº de identificação civil).
            </p>
          )}
        </div>

        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancelar</button>
          <button className="btn-primary" disabled={busy || !title.trim()}>
            {busy ? <Spinner className="h-4 w-4 text-white" /> : null} Criar e rever
          </button>
        </div>
      </form>
    </Modal>
  );
}
