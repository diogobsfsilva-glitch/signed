import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { DocStatus } from "../../supabase/functions/_shared/types";
import { EmptyState, FolderIcon, FullPageSpinner, ModeBadge, Modal, PlusIcon, StatusBadge, toast } from "../components/ui";
import { errorMessage, relative } from "../lib/format";
import { documentAction } from "../lib/api";

interface Row {
  id: string;
  title: string;
  status: DocStatus;
  signature_mode: "simple" | "qualified";
  parts: { name: string; pages: number }[] | null;
  updated_at: string;
  sent_at: string | null;
  owner_id: string;
  folder_id: string | null;
  workspace_id: string;
  batch_id: string | null;
  public_link_id: string | null;
  recipients: { name: string; role: string; status: string }[];
  owner: { full_name: string | null; email: string } | null;
}

interface Folder {
  id: string;
  name: string;
  workspace_id: string;
}

const TABS: { key: string; label: string; statuses: DocStatus[] | null }[] = [
  { key: "all", label: "Todos", statuses: null },
  { key: "progress", label: "Em curso", statuses: ["in_progress"] },
  { key: "draft", label: "Rascunhos", statuses: ["draft"] },
  { key: "completed", label: "Concluídos", statuses: ["completed"] },
  { key: "closed", label: "Rejeitados / expirados", statuses: ["declined", "expired", "cancelled"] },
];

export function Dashboard() {
  const { profile, workspaces } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("estado") ?? "all";
  const folder = params.get("pasta");
  const batch = params.get("lote");
  const linkId = params.get("link");
  const [batchTitle, setBatchTitle] = useState<string | null>(null);
  useEffect(() => {
    if (batch) supabase.from("batches").select("title").eq("id", batch).maybeSingle().then(({ data }) => setBatchTitle(`Envio em massa: ${data?.title ?? "lote"}`));
    else if (linkId) supabase.from("public_links").select("title").eq("id", linkId).maybeSingle().then(({ data }) => setBatchTitle(`Link público: ${data?.title ?? "link"}`));
    else setBatchTitle(null);
  }, [batch, linkId]);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [newFolder, setNewFolder] = useState(false);
  // Seleção de documentos em curso para ações em massa (lembrar, cancelar).
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  async function bulk(action: "remind" | "cancel") {
    const ids = [...picked];
    if (action === "cancel" && !confirm(`Cancelar ${ids.length} documento(s)? Os links deixam de funcionar.`)) return;
    setBulkBusy(true);
    let ok = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        await documentAction(action, id);
        ok++;
      } catch (e) {
        errors.push(`${rows?.find((x) => x.id === id)?.title}: ${errorMessage(e)}`);
      }
    }
    setBulkBusy(false);
    setPicked(new Set());
    toast(`${ok} ${action === "remind" ? "lembrete(s) enviado(s)" : "documento(s) cancelado(s)"}${errors.length ? `; ${errors.length} com erro` : ""}.`, errors.length ? "error" : "ok");
    if (errors.length) console.warn(errors);
    load();
  }
  const nav = useNavigate();

  async function load() {
    const [{ data: docs, error }, { data: f }] = await Promise.all([
      supabase
        .from("documents")
        .select("id, title, status, signature_mode, parts, updated_at, sent_at, owner_id, folder_id, workspace_id, batch_id, public_link_id, recipients(name, role, status), owner:profiles!documents_owner_id_fkey(full_name, email)")
        .eq("is_template", false)
        .order("updated_at", { ascending: false })
        .limit(500),
      supabase.from("folders").select("id, name, workspace_id").order("name"),
    ]);
    if (error) toast(errorMessage(error), "error");
    setRows((docs as unknown as Row[]) ?? []);
    setFolders(f ?? []);
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const statuses = TABS.find((t) => t.key === tab)?.statuses;
    const term = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!statuses || statuses.includes(r.status)) &&
        (!folder || r.folder_id === folder) &&
        (!batch || r.batch_id === batch) &&
        (!linkId || r.public_link_id === linkId) &&
        (!term || r.title.toLowerCase().includes(term) || r.recipients.some((x) => x.name.toLowerCase().includes(term))),
    );
  }, [rows, tab, q, folder, batch, linkId]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of TABS) c[t.key] = rows?.filter((r) => !t.statuses || t.statuses.includes(r.status)).length ?? 0;
    return c;
  }, [rows]);

  function set(k: string, v: string | null) {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  }

  if (!rows) return <FullPageSpinner />;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Documentos</h1>
          <p className="muted mt-0.5">Olá, {profile?.full_name?.split(" ")[0]}. {counts.progress ? `${counts.progress} em curso.` : "Nada pendente."}</p>
        </div>
        <Link to="/novo" className="btn-primary">
          <PlusIcon className="h-4 w-4" /> Novo documento
        </Link>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[200px_1fr]">
        <aside className="hidden lg:block">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Pastas</p>
          <div className="flex flex-col gap-0.5">
            <button className={`rounded-md px-2.5 py-1.5 text-left text-sm ${!folder ? "bg-navy-50 font-medium text-navy-900" : "text-slate-700 hover:bg-slate-100"}`} onClick={() => set("pasta", null)}>
              Todas
            </button>
            {folders.map((f) => (
              <button
                key={f.id}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${folder === f.id ? "bg-navy-50 font-medium text-navy-900" : "text-slate-700 hover:bg-slate-100"}`}
                onClick={() => set("pasta", f.id)}
              >
                <FolderIcon className="h-4 w-4 shrink-0 text-slate-400" />
                <span className="truncate">{f.name}</span>
              </button>
            ))}
            <button className="mt-1 rounded-md px-2.5 py-1.5 text-left text-sm text-navy-600 hover:bg-slate-100" onClick={() => setNewFolder(true)}>
              + Nova pasta
            </button>
          </div>
        </aside>

        <section className="min-w-0">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => set("estado", t.key === "all" ? null : t.key)}
                  className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${tab === t.key ? "bg-navy-900 text-white" : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"}`}
                >
                  {t.label} <span className={tab === t.key ? "text-navy-200" : "text-slate-400"}>{counts[t.key]}</span>
                </button>
              ))}
            </div>
            <input className="input sm:max-w-60" placeholder="Pesquisar título ou pessoa" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Pesquisar" />
          </div>
          {(batch || linkId) && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-navy-50 px-3 py-2 text-sm text-navy-900">
              <strong>{batchTitle}</strong>
              <button className="text-navy-600 underline" onClick={() => { const p = new URLSearchParams(params); p.delete("lote"); p.delete("link"); setParams(p, { replace: true }); }}>Ver todos</button>
            </div>
          )}
          <select className="input mt-3 lg:hidden" value={folder ?? ""} onChange={(e) => set("pasta", e.target.value || null)} aria-label="Pasta">
            <option value="">Todas as pastas</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>

          <div className="mt-4">
            {filtered.length === 0 ? (
              <EmptyState
                title={rows.length === 0 ? "Ainda não há documentos" : "Nenhum documento encontrado"}
                action={
                  rows.length === 0 && (
                    <Link to="/novo" className="btn-primary">
                      Carregar o primeiro documento
                    </Link>
                  )
                }
              >
                {rows.length === 0 ? "Carregue um PDF ou Word, indique quem assina e onde, e envie." : "Experimente outro filtro ou pesquisa."}
              </EmptyState>
            ) : (
              <>
              {picked.size > 0 && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-navy-50 px-3 py-2 text-sm text-navy-900">
                  <span><strong>{picked.size}</strong> documento(s) em curso selecionado(s)</span>
                  <span className="flex gap-2">
                    <button className="btn-secondary py-1" disabled={bulkBusy} onClick={() => bulk("remind")}>Enviar lembrete</button>
                    <button className="btn-danger py-1" disabled={bulkBusy} onClick={() => bulk("cancel")}>Cancelar</button>
                    <button className="btn-ghost py-1" disabled={bulkBusy} onClick={() => setPicked(new Set())}>Limpar</button>
                  </span>
                </div>
              )}
              <ul className="card divide-y divide-slate-100 overflow-hidden">
                {filtered.map((r) => {
                  const signers = r.recipients.filter((x) => x.role === "signer");
                  const done = signers.filter((x) => x.status === "signed").length;
                  const mine = r.owner_id === profile?.id;
                  return (
                    <li key={r.id} className="flex items-stretch">
                      <span className="flex w-9 shrink-0 items-center justify-center">
                        {r.status === "in_progress" && (
                          <input
                            type="checkbox"
                            aria-label={`Selecionar ${r.title}`}
                            checked={picked.has(r.id)}
                            onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })}
                          />
                        )}
                      </span>
                      <button
                        className="flex min-w-0 flex-1 flex-col gap-2 py-3.5 pr-4 text-left hover:bg-slate-50 sm:flex-row sm:items-center sm:gap-4"
                        onClick={() => nav(r.status === "draft" ? `/documentos/${r.id}/editar` : `/documentos/${r.id}`)}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-slate-900">{r.title}</p>
                          <p className="mt-0.5 truncate text-sm text-slate-500">
                            {signers.length ? signers.map((s) => s.name).join(", ") : "Sem destinatários"}
                            {!mine && r.owner && <span className="text-slate-400"> · de {r.owner.full_name ?? r.owner.email}</span>}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          {r.parts && r.parts.length > 1 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600" title={r.parts.map((p) => p.name).join("\n")}>Pacote · {r.parts.length}</span>}
                          <ModeBadge mode={r.signature_mode} />
                          {r.status === "in_progress" && (
                            <span className="text-xs tabular-nums text-slate-500">
                              {done}/{signers.length} assinaram
                            </span>
                          )}
                          <StatusBadge status={r.status} />
                          <span className="w-20 text-right text-xs text-slate-400">{relative(r.updated_at)}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
              </>
            )}
          </div>
        </section>
      </div>

      <NewFolderModal
        open={newFolder}
        onClose={() => setNewFolder(false)}
        workspaces={workspaces}
        onCreated={() => {
          setNewFolder(false);
          load();
        }}
      />
    </div>
  );
}

function NewFolderModal({ open, onClose, workspaces, onCreated }: { open: boolean; onClose: () => void; workspaces: { id: string; name: string }[]; onCreated: () => void }) {
  const { profile } = useAuth();
  const [name, setName] = useState("");
  const [ws, setWs] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setWs(workspaces[0]?.id ?? "");
    }
  }, [open, workspaces]);
  return (
    <Modal open={open} onClose={onClose} title="Nova pasta">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const { error } = await supabase.from("folders").insert({ name: name.trim(), workspace_id: ws, created_by: profile!.id });
          if (error) toast(errorMessage(error), "error");
          else onCreated();
        }}
        className="space-y-3"
      >
        <div>
          <label className="label" htmlFor="fname">Nome</label>
          <input id="fname" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus />
        </div>
        {workspaces.length > 1 && (
          <div>
            <label className="label" htmlFor="fws">Espaço de trabalho</label>
            <select id="fws" className="input" value={ws} onChange={(e) => setWs(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button className="btn-primary" disabled={!name.trim()}>Criar</button>
        </div>
      </form>
    </Modal>
  );
}
