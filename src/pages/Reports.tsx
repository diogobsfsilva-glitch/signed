// Relatórios: indicadores do período, pendentes por hotel, documentos a expirar e parados, exportação CSV.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { toCsv } from "../lib/csv";
import { DownloadIcon, FullPageSpinner, StatusBadge, toast } from "../components/ui";
import type { DocStatus } from "../../supabase/functions/_shared/types";
import { STATUS_LABELS } from "../../supabase/functions/_shared/types";
import { errorMessage, fmtDate, fmtDateTime } from "../lib/format";

interface Row {
  id: string;
  title: string;
  status: DocStatus;
  signature_mode: "simple" | "qualified";
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  workspace: { name: string } | null;
  owner: { full_name: string | null; email: string } | null;
  recipients: { name: string; role: string; status: string; signed_at: string | null }[];
}

const PERIODS = [
  { days: 30, label: "30 dias" },
  { days: 90, label: "90 dias" },
  { days: 365, label: "12 meses" },
  { days: 0, label: "Tudo" },
];
const DAY = 86_400_000;

function duration(ms: number): string {
  if (ms < 3600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 2 * DAY) return `${Math.round(ms / 3600_000)} h`;
  return `${(ms / DAY).toFixed(1).replace(".", ",")} dias`;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function Reports() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [days, setDays] = useState(30);

  // Lê tudo por páginas de 1000 (o limite do servidor por pedido), até 20 000 documentos.
  useEffect(() => {
    (async () => {
      const all: Row[] = [];
      for (let from = 0; from < 20_000; from += 1000) {
        const { data, error } = await supabase
          .from("documents")
          .select("id, title, status, signature_mode, created_at, sent_at, completed_at, expires_at, workspace:workspaces(name), owner:profiles!documents_owner_id_fkey(full_name, email), recipients(name, role, status, signed_at)")
          .eq("is_template", false)
          .neq("status", "draft")
          .order("sent_at", { ascending: false })
          .order("id")
          .range(from, from + 999);
        if (error) {
          toast(errorMessage(error), "error");
          break;
        }
        all.push(...((data as unknown as Row[]) ?? []));
        if ((data?.length ?? 0) < 1000) break;
      }
      setRows(all);
    })();
  }, []);

  const r = useMemo(() => {
    if (!rows) return null;
    const now = Date.now();
    const since = days ? now - days * DAY : 0;
    const inPeriod = rows.filter((d) => d.sent_at && new Date(d.sent_at).getTime() >= since);
    const completed = inPeriod.filter((d) => d.status === "completed");
    const closed = inPeriod.filter((d) => d.status !== "in_progress");
    const times = completed.filter((d) => d.completed_at && d.sent_at).map((d) => new Date(d.completed_at!).getTime() - new Date(d.sent_at!).getTime());
    const open = rows.filter((d) => d.status === "in_progress");
    const byWs = new Map<string, number>();
    for (const d of open) byWs.set(d.workspace?.name ?? "—", (byWs.get(d.workspace?.name ?? "—") ?? 0) + 1);
    const bySender = new Map<string, number>();
    for (const d of inPeriod) {
      const k = d.owner?.full_name || d.owner?.email || "—";
      bySender.set(k, (bySender.get(k) ?? 0) + 1);
    }
    const statusCount = new Map<DocStatus, number>();
    for (const d of inPeriod) statusCount.set(d.status, (statusCount.get(d.status) ?? 0) + 1);
    const expiring = open
      .filter((d) => d.expires_at && new Date(d.expires_at).getTime() - now < 7 * DAY)
      .sort((a, b) => new Date(a.expires_at!).getTime() - new Date(b.expires_at!).getTime());
    const stalled = open
      .filter((d) => {
        const last = Math.max(new Date(d.sent_at!).getTime(), ...d.recipients.map((x) => (x.signed_at ? new Date(x.signed_at).getTime() : 0)));
        return now - last > 7 * DAY;
      })
      .sort((a, b) => new Date(a.sent_at!).getTime() - new Date(b.sent_at!).getTime());
    return {
      inPeriod,
      sent: inPeriod.length,
      completed: completed.length,
      rate: closed.length ? Math.round((completed.length / closed.length) * 100) : null,
      median: median(times),
      open: open.length,
      expiring,
      stalled,
      byWs: [...byWs.entries()].sort((a, b) => b[1] - a[1]),
      bySender: [...bySender.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
      statusCount,
    };
  }, [rows, days]);

  if (!rows || !r) return <FullPageSpinner />;

  function exportCsv() {
    const header = ["Título", "Espaço de trabalho", "Remetente", "Tipo", "Estado", "Enviado", "Concluído", "Prazo", "Signatários", "Assinaram", "Tempo até concluir (horas)"];
    const lines = r!.inPeriod.map((d) => {
      const signers = d.recipients.filter((x) => x.role === "signer");
      const hours = d.completed_at && d.sent_at ? ((new Date(d.completed_at).getTime() - new Date(d.sent_at).getTime()) / 3600_000).toFixed(1).replace(".", ",") : "";
      return [
        d.title, d.workspace?.name ?? "", d.owner?.full_name || d.owner?.email || "", d.signature_mode === "qualified" ? "Cartão de Cidadão" : "Simples",
        STATUS_LABELS[d.status], fmtDateTime(d.sent_at), d.completed_at ? fmtDateTime(d.completed_at) : "", d.expires_at ? fmtDate(d.expires_at) : "",
        signers.map((x) => x.name).join(", "), String(signers.filter((x) => x.status === "signed").length), hours,
      ];
    });
    const blob = new Blob([toCsv([header, ...lines])], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `signed_relatorio_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Relatórios</h1>
          <p className="muted mt-0.5">Documentos enviados a que tem acesso (os seus e os dos espaços que administra).</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg bg-white p-1 text-sm ring-1 ring-slate-200" role="tablist" aria-label="Período">
            {PERIODS.map((p) => (
              <button key={p.days} role="tab" aria-selected={days === p.days} className={`rounded-md px-3 py-1 font-medium ${days === p.days ? "bg-navy-900 text-white" : "text-slate-600 hover:bg-slate-50"}`} onClick={() => setDays(p.days)}>
                {p.label}
              </button>
            ))}
          </div>
          <button className="btn-secondary" onClick={exportCsv} disabled={!r.inPeriod.length}><DownloadIcon className="h-4 w-4" /> Exportar CSV</button>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Enviados" value={String(r.sent)} />
        <Tile label="Concluídos" value={String(r.completed)} hint={r.rate !== null ? `${r.rate}% dos fechados` : undefined} />
        <Tile label="Tempo mediano até concluir" value={r.median !== null ? duration(r.median) : "—"} />
        <Tile label="Em curso agora" value={String(r.open)} hint={r.expiring.length ? `${r.expiring.length} a expirar em 7 dias` : undefined} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="font-semibold">Em curso por espaço de trabalho</h2>
          <Bars rows={r.byWs} unit="em curso" empty="Nada em curso." />
        </section>
        <section className="card p-4">
          <h2 className="font-semibold">Enviados por remetente <span className="font-normal text-slate-500">· período</span></h2>
          <Bars rows={r.bySender} unit="enviados" empty="Sem envios no período." />
        </section>
      </div>

      <section className="card mt-6 p-4">
        <h2 className="font-semibold">Estado dos documentos enviados no período</h2>
        <div className="mt-3 flex flex-wrap gap-3">
          {(["in_progress", "completed", "declined", "expired", "cancelled"] as DocStatus[]).map((s) => (
            <div key={s} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
              <StatusBadge status={s} />
              <span className="text-lg font-semibold tabular-nums">{r.statusCount.get(s) ?? 0}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <DocList title="A expirar nos próximos 7 dias" rows={r.expiring} meta={(d) => `prazo ${fmtDateTime(d.expires_at)}`} empty="Nenhum documento a expirar." />
        <DocList title="Parados há mais de 7 dias" rows={r.stalled} meta={(d) => `enviado ${fmtDate(d.sent_at)}`} empty="Nenhum documento parado." />
      </div>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** Barras horizontais de uma só série (uma cor), valor escrito à direita. */
function Bars({ rows, unit, empty }: { rows: [string, number][]; unit: string; empty: string }) {
  if (!rows.length) return <p className="muted mt-3">{empty}</p>;
  const max = Math.max(...rows.map((x) => x[1]));
  return (
    <ul className="mt-3 space-y-2">
      {rows.map(([k, v]) => (
        <li key={k} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm" title={`${k}: ${v} ${unit}`}>
          <span className="truncate text-slate-700">{k}</span>
          <span className="h-3 rounded-r bg-slate-100">
            <span className="block h-3 rounded-r bg-navy-700" style={{ width: `${Math.max(2, (v / max) * 100)}%` }} />
          </span>
          <span className="w-8 text-right font-medium tabular-nums text-slate-900">{v}</span>
        </li>
      ))}
    </ul>
  );
}

function DocList({ title, rows, meta, empty }: { title: string; rows: Row[]; meta: (d: Row) => string; empty: string }) {
  return (
    <section className="card p-4">
      <h2 className="font-semibold">{title} <span className="font-normal text-slate-500">({rows.length})</span></h2>
      {rows.length === 0 ? (
        <p className="muted mt-3">{empty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {rows.slice(0, 20).map((d) => {
            const signers = d.recipients.filter((x) => x.role === "signer");
            return (
              <li key={d.id} className="py-2 text-sm">
                <Link to={`/documentos/${d.id}`} className="font-medium text-slate-900 hover:underline">{d.title}</Link>
                <p className="text-xs text-slate-500">
                  {d.workspace?.name} · {signers.filter((x) => x.status === "signed").length}/{signers.length} assinaram · {meta(d)}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
