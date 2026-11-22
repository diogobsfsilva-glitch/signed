// Envio em massa: um modelo + um CSV = um documento por linha, cada um enviado à sua pessoa.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { documentAction } from "../lib/api";
import { instantiate } from "../lib/templates";
import { cellToValue, mapColumns, normalizeKey, parseCsv, parseLanguage, toCsv } from "../lib/csv";
import { isPrefillable, type FieldType } from "../../supabase/functions/_shared/types";
import { Alert, CheckIcon, DownloadIcon, FullPageSpinner, ModeBadge, Spinner, UploadIcon } from "../components/ui";
import { errorMessage } from "../lib/format";

const MAX_ROWS = 200;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface TRecipient { id: string; name: string; email: string; role: "signer" | "cc"; signing_order: number; color: string; group_emails: string[] | null }
interface TField { id: string; recipient_id: string; type: FieldType; label: string | null; options: string[] | null; readonly: boolean }
interface Template {
  id: string;
  title: string;
  workspace_id: string;
  original_path: string | null;
  signature_mode: "simple" | "qualified";
  is_template: boolean;
  recipients: TRecipient[];
  fields: TField[];
}
interface Row {
  line: number;
  name: string;
  email: string;
  civilId: string | null;
  language: string | null;
  /** rótulo do campo (como no modelo) -> valor */
  values: Record<string, string | null>;
  errors: string[];
}
interface Result {
  state: "waiting" | "working" | "sent" | "failed";
  docId?: string;
  sent?: boolean;
  error?: string;
}

export function BulkSend() {
  const { id } = useParams();
  const { profile } = useAuth();
  const [tpl, setTpl] = useState<Template | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [varId, setVarId] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pattern, setPattern] = useState("");
  const [results, setResults] = useState<Record<number, Result>>({});
  const [running, setRunning] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("documents")
      .select("id, title, workspace_id, original_path, signature_mode, is_template, recipients(id, name, email, role, signing_order, color, group_emails), fields(id, recipient_id, type, label, options, readonly)")
      .eq("id", id!)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error || !data || !data.is_template) return setLoadError("Modelo não encontrado.");
        const t = data as unknown as Template;
        t.recipients.sort((a, b) => a.signing_order - b.signing_order);
        setTpl(t);
        const signers = t.recipients.filter((r) => r.role === "signer" && !r.group_emails?.length);
        setVarId((signers.find((r) => !r.email) ?? signers[0])?.id ?? "");
        setPattern(`${t.title} — {nome}`);
      });
  }, [id]);

  // Campos que o CSV pode preencher: campos de dados com nome (rótulo), agrupados pelo rótulo.
  const prefill = useMemo(() => {
    const m = new Map<string, { label: string; type: FieldType; options: string[] | null }>();
    for (const f of tpl?.fields ?? []) {
      if (!f.label || !isPrefillable(f.type)) continue;
      const k = normalizeKey(f.label);
      if (!m.has(k)) m.set(k, { label: f.label, type: f.type, options: f.options });
    }
    return m;
  }, [tpl]);

  if (loadError) return <div className="p-8"><Alert>{loadError}</Alert></div>;
  if (!tpl) return <FullPageSpinner />;

  const variable = tpl.recipients.find((r) => r.id === varId);
  const fixed = tpl.recipients.filter((r) => r.id !== varId);
  const fixedMissing = fixed.filter((r) => !r.email && !r.group_emails?.length);
  const qualified = tpl.signature_mode === "qualified";
  const valid = rows.filter((r) => r.errors.length === 0);
  const done = Object.values(results).filter((r) => r.state === "sent").length;
  const failed = Object.entries(results).filter(([, r]) => r.state === "failed");

  function downloadExample() {
    const header = ["nome", "email", "idioma", ...(qualified ? ["NIC"] : []), ...[...prefill.values()].map((p) => p.label)];
    const example = ["Joana Reis", "joana.reis@exemplo.pt", "PT", ...(qualified ? ["12345678"] : []), ...[...prefill.values()].map((p) =>
      p.type === "date" ? "01/01/2027" : p.type === "checkbox" ? "sim" : p.options?.[0] ?? "")];
    const blob = new Blob([toCsv([header, example])], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${tpl!.title.replace(/[^\w\- ]+/g, "").trim() || "modelo"}_envio_em_massa.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    setCsvError(null);
    setWarnings([]);
    setRows([]);
    setResults({});
    setBatchId(null);
    setFileName(file.name);
    let text = await file.text();
    // Excel antigo grava em Windows-1252: se houver caracteres inválidos, tenta de novo nessa codificação.
    if (text.includes("�")) text = new TextDecoder("windows-1252").decode(await file.arrayBuffer());
    const all = parseCsv(text);
    if (all.length < 2) return setCsvError("O ficheiro não tem linhas além do cabeçalho.");
    const cols = mapColumns(all[0], [...prefill.values()].map((p) => p.label));
    if (cols.name < 0 || cols.email < 0) return setCsvError("O cabeçalho tem de ter as colunas «nome» e «email». Descarregue o exemplo para ver o formato.");
    if (all.length - 1 > MAX_ROWS) return setCsvError(`No máximo ${MAX_ROWS} linhas por envio (o ficheiro tem ${all.length - 1}).`);
    const w: string[] = [];
    if (cols.unknown.length) w.push(`Colunas ignoradas (não correspondem a nenhum campo do modelo): ${cols.unknown.join(", ")}.`);
    const fixedEmails = new Set(fixed.flatMap((r) => (r.group_emails?.length ? r.group_emails : [r.email])).map((e) => e.toLowerCase()).filter(Boolean));
    const seen = new Set<string>();
    const parsed: Row[] = all.slice(1).map((cells, i) => {
      const errors: string[] = [];
      const name = (cells[cols.name] ?? "").trim();
      const email = (cells[cols.email] ?? "").trim().toLowerCase();
      if (!name) errors.push("falta o nome");
      if (!EMAIL_RE.test(email)) errors.push(email ? `email inválido «${email}»` : "falta o email");
      else if (seen.has(email)) errors.push("email repetido no ficheiro");
      else if (fixedEmails.has(email)) errors.push("este email já é de outro papel do modelo");
      seen.add(email);
      let civilId: string | null = null;
      if (cols.civilId >= 0 && cells[cols.civilId]) {
        civilId = cells[cols.civilId].replace(/\D/g, "");
        if (civilId.length < 6 || civilId.length > 9) errors.push("nº de identificação civil inválido");
      }
      let language: string | null = null;
      if (cols.language >= 0 && cells[cols.language]) {
        language = parseLanguage(cells[cols.language]);
        if (!language) errors.push(`idioma desconhecido «${cells[cols.language]}» (use PT, EN, ES ou FR)`);
      }
      const values: Record<string, string | null> = {};
      for (const [idx, key] of cols.fields) {
        const p = prefill.get(key)!;
        const r = cellToValue(p.type, cells[idx] ?? "", p.options);
        if (r.error) errors.push(`${p.label}: ${r.error}`);
        else if (r.value !== null) values[p.label] = r.value;
      }
      return { line: i + 2, name, email, civilId, language, values, errors };
    });
    setWarnings(w);
    setRows(parsed);
  }

  async function sendOne(row: Row, batch: string, prev?: Result): Promise<Result> {
    let docId = prev?.docId;
    try {
      if (!docId) {
        docId = await instantiate({
          sourceId: tpl!.id,
          sourcePath: tpl!.original_path!,
          asTemplate: false,
          title: pattern.replace(/\{nome\}/gi, row.name).slice(0, 200) || tpl!.title,
          workspaceId: tpl!.workspace_id,
          recipients: [{ id: varId, name: row.name, email: row.email, civil_id: row.civilId, ...(row.language ? { language: row.language } : {}) }],
          batchId: batch,
        });
        for (const [label, value] of Object.entries(row.values)) {
          const { error } = await supabase.from("fields").update({ value }).eq("document_id", docId).eq("label", label);
          if (error) throw error;
        }
      }
      await documentAction("send", docId);
      return { state: "sent", docId, sent: true };
    } catch (e) {
      return { state: "failed", docId, error: errorMessage(e) };
    }
  }

  async function run(only?: Row[]) {
    if (!profile) return;
    setRunning(true);
    try {
      let batch = batchId;
      if (!batch) {
        const { data, error } = await supabase
          .from("batches")
          .insert({ workspace_id: tpl!.workspace_id, owner_id: profile.id, template_id: tpl!.id, title: `${tpl!.title} (${valid.length})`, total: valid.length })
          .select("id")
          .single();
        if (error) throw error;
        batch = data.id as string;
        setBatchId(batch);
      }
      const list = only ?? valid;
      setResults((r) => ({ ...r, ...Object.fromEntries(list.map((x) => [x.line, { ...r[x.line], state: "waiting" as const }])) }));
      for (const row of list) {
        setResults((r) => ({ ...r, [row.line]: { ...r[row.line], state: "working" } }));
        const prev = results[row.line];
        const res = await sendOne(row, batch!, prev);
        setResults((r) => ({ ...r, [row.line]: res }));
      }
    } catch (e) {
      setCsvError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  const started = Object.keys(results).length > 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:py-8">
      <Link to="/modelos" className="text-sm text-slate-500 hover:text-slate-800">← Modelos</Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Envio em massa</h1>
        <ModeBadge mode={tpl.signature_mode} />
      </div>
      <p className="muted mt-1">
        Modelo <strong>{tpl.title}</strong>. Cada linha do ficheiro cria e envia um documento à pessoa indicada.
      </p>

      {/* 1. Papel variável */}
      <section className="card mt-6 p-5">
        <h2 className="font-semibold">1. Quem muda em cada documento</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {tpl.recipients.filter((r) => r.role === "signer" && !r.group_emails?.length).map((r) => (
            <label key={r.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm ${varId === r.id ? "border-navy-500 bg-navy-50" : "border-slate-200"}`}>
              <input type="radio" name="var" checked={varId === r.id} onChange={() => setVarId(r.id)} disabled={started} />
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />
              <span className="min-w-0 flex-1 truncate">
                <strong>{r.name}</strong> <span className="text-slate-500">{r.email ? `· ${r.email}` : "· sem email fixo"}</span>
              </span>
            </label>
          ))}
        </div>
        {fixed.length > 0 && (
          <p className="mt-3 text-sm text-slate-600">
            Fixos em todos os documentos: {fixed.map((r) => `${r.name}${r.email ? ` (${r.email})` : r.group_emails?.length ? " (grupo)" : ""}`).join(", ")}.
          </p>
        )}
        {fixedMissing.length > 0 && (
          <div className="mt-3">
            <Alert kind="warning">
              {fixedMissing.map((r) => r.name).join(", ")} não {fixedMissing.length > 1 ? "têm" : "tem"} email no modelo. No envio em massa só um papel pode mudar: edite o modelo e indique o email {fixedMissing.length > 1 ? "desses papéis" : "desse papel"}.
            </Alert>
          </div>
        )}
      </section>

      {/* 2. Ficheiro */}
      <section className="card mt-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">2. Lista de pessoas (CSV)</h2>
            <p className="mt-1 text-sm text-slate-600">
              Colunas obrigatórias: <strong>nome</strong> e <strong>email</strong>
              ; opcional: <strong>idioma</strong> (PT, EN, ES ou FR){qualified && <>, <strong>NIC</strong> (nº de identificação civil)</>}
              {prefill.size > 0 && <>. Pode preencher também: {[...prefill.values()].map((p) => <strong key={p.label}>{p.label}</strong>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, ", ", x] : [x]), [])}</>}.
              {" "}No Excel: <em>Guardar como → CSV (separado por vírgulas)</em>.
            </p>
          </div>
          <button className="btn-secondary" onClick={downloadExample}><DownloadIcon className="h-4 w-4" /> Exemplo CSV</button>
        </div>
        {prefill.size === 0 && (
          <p className="mt-2 text-xs text-slate-500">Dica: dê um nome aos campos de texto, data ou lista do modelo (ex.: «Vencimento») para os preencher a partir do ficheiro.</p>
        )}
        <label className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center ${started ? "pointer-events-none opacity-60" : "border-slate-300 bg-slate-50 hover:bg-slate-100"}`}>
          <UploadIcon className="h-7 w-7 text-slate-400" />
          <span className="mt-2 text-sm font-medium">{fileName ?? "Escolher ficheiro CSV"}</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" disabled={started} onChange={(e) => readFile(e.target.files?.[0])} />
        </label>
        {csvError && <div className="mt-3"><Alert>{csvError}</Alert></div>}
        {warnings.map((w) => <div key={w} className="mt-3"><Alert kind="warning">{w}</Alert></div>)}
      </section>

      {/* 3. Rever e enviar */}
      {rows.length > 0 && (
        <section className="card mt-4 p-5">
          <h2 className="font-semibold">3. Rever e enviar</h2>
          <div className="mt-3 max-w-xl">
            <label className="label" htmlFor="pattern">Título de cada documento</label>
            <input id="pattern" className="input" value={pattern} onChange={(e) => setPattern(e.target.value)} maxLength={200} disabled={started} />
            <p className="mt-1 text-xs text-slate-500">{"{nome}"} é substituído pelo nome de cada pessoa.</p>
          </div>

          <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">Linha</th>
                  <th className="px-3 py-2">{variable?.name ?? "Pessoa"}</th>
                  <th className="px-3 py-2">Campos</th>
                  <th className="px-3 py-2">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const res = results[r.line];
                  return (
                    <tr key={r.line} className={r.errors.length ? "bg-red-50/60" : ""}>
                      <td className="px-3 py-2 text-slate-400">{r.line}</td>
                      <td className="px-3 py-2">
                        <span className="block font-medium">{r.name || "—"}</span>
                        <span className="block text-xs text-slate-500">{r.email}</span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {Object.entries(r.values).map(([k, v]) => `${k}: ${v === "true" ? "sim" : v === "false" ? "não" : v}`).join(" · ") || "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.errors.length ? (
                          <span className="text-red-700">{r.errors.join("; ")}</span>
                        ) : !res ? (
                          <span className="text-slate-500">Pronto</span>
                        ) : res.state === "working" ? (
                          <span className="flex items-center gap-1 text-navy-700"><Spinner className="h-3.5 w-3.5" /> A enviar…</span>
                        ) : res.state === "waiting" ? (
                          <span className="text-slate-500">Na fila</span>
                        ) : res.state === "sent" ? (
                          <Link to={`/documentos/${res.docId}`} className="flex items-center gap-1 text-emerald-700 hover:underline"><CheckIcon className="h-3.5 w-3.5" /> Enviado</Link>
                        ) : (
                          <span className="text-red-700">Falhou: {res.error}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-600">
              {valid.length} de {rows.length} linha(s) válida(s)
              {rows.length - valid.length > 0 && " — as linhas com erro não são enviadas (corrija o ficheiro e carregue de novo)"}
              {started && ` · ${done} enviado(s)${failed.length ? ` · ${failed.length} com falha` : ""}`}.
            </p>
            <div className="flex gap-2">
              {batchId && !running && (
                <Link to={`/?lote=${batchId}`} className="btn-secondary">Ver documentos do lote</Link>
              )}
              {failed.length > 0 && !running && (
                <button className="btn-secondary" onClick={() => run(rows.filter((r) => failed.some(([l]) => Number(l) === r.line)))}>Repetir os que falharam</button>
              )}
              {!started && (
                <button
                  className="btn-primary"
                  disabled={running || valid.length === 0 || fixedMissing.length > 0 || !variable || !pattern.trim()}
                  onClick={() => {
                    if (confirm(`Criar e enviar ${valid.length} documento(s)? Cada pessoa recebe o seu por email.`)) run();
                  }}
                >
                  Enviar {valid.length} documento(s)
                </button>
              )}
              {running && <span className="flex items-center gap-2 text-sm text-slate-600"><Spinner className="h-4 w-4" /> A enviar {done}/{valid.length}… não feche esta página.</span>}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

