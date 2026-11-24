import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase, BUCKET } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { convertDocx } from "../lib/api";
import { openPdf, pageSizes } from "../lib/pdf";
import { baseName, buildPackage, fileKind, fileToPdf, MAX_FILE } from "../lib/package";
import { Alert, ArrowDown, ArrowUp, Spinner, TrashIcon, UploadIcon } from "../components/ui";
import { errorMessage } from "../lib/format";
import { MAX_PARTS } from "../../supabase/functions/_shared/types";

interface Item {
  key: string;
  file: File;
  name: string;
}

export function NewDocument() {
  const { profile, workspaces } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const asTemplate = params.get("modelo") === "1";
  const [items, setItems] = useState<Item[]>([]);
  const [title, setTitle] = useState("");
  const [ws, setWs] = useState(workspaces[0]?.id ?? "");
  const [folder, setFolder] = useState("");
  const [folders, setFolders] = useState<{ id: string; name: string; workspace_id: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    supabase.from("folders").select("id, name, workspace_id").order("name").then(({ data }) => setFolders(data ?? []));
  }, []);

  function pick(list: FileList | File[] | null | undefined) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setError(null);
    const bad = files.find((f) => !fileKind(f));
    if (bad) return setError(`"${bad.name}": escolha ficheiros PDF ou Word (.docx).`);
    const big = files.find((f) => f.size > MAX_FILE);
    if (big) return setError(`"${big.name}" tem mais de 25 MB.`);
    const next = [...items, ...files.map((f) => ({ key: crypto.randomUUID(), file: f, name: baseName(f) }))];
    if (next.length > MAX_PARTS) return setError(`Um pacote pode ter até ${MAX_PARTS} documentos.`);
    setItems(next);
    if (!title) setTitle(next[0].name);
  }

  function moveItem(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const x = [...items];
    [x[i], x[j]] = [x[j], x[i]];
    setItems(x);
  }

  async function create() {
    if (!items.length || !profile) return;
    setError(null);
    let docId: string | null = null;
    try {
      setBusy("A criar o documento…");
      const { data: doc, error } = await supabase
        .from("documents")
        .insert({ title: title.trim(), workspace_id: ws, folder_id: folder || null, owner_id: profile.id, is_template: asTemplate })
        .select("id, workspace_id")
        .single();
      if (error) throw error;
      docId = doc.id;
      const base = `${doc.workspace_id}/${doc.id}`;
      let pdfBytes: ArrayBuffer;
      let parts: { name: string; pages: number }[] | null = null;
      if (items.length === 1 && fileKind(items[0].file) === "docx") {
        const file = items[0].file;
        setBusy("A carregar o Word…");
        const up = await supabase.storage.from(BUCKET).upload(`${base}/upload.docx`, file, {
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
        if (up.error) throw up.error;
        setBusy("A converter para PDF…");
        await convertDocx(doc.id);
        const dl = await supabase.storage.from(BUCKET).download(`${base}/original.pdf`);
        if (dl.error) throw dl.error;
        pdfBytes = await dl.data.arrayBuffer();
      } else if (items.length === 1) {
        const file = items[0].file;
        pdfBytes = await file.arrayBuffer();
        setBusy("A verificar o PDF…");
        try {
          await openPdf(pdfBytes.slice(0));
        } catch {
          throw new Error("Não foi possível abrir o PDF. Está protegido com palavra-passe ou danificado?");
        }
        setBusy("A carregar o PDF…");
        const up = await supabase.storage.from(BUCKET).upload(`${base}/original.pdf`, file, { contentType: "application/pdf", upsert: true });
        if (up.error) throw up.error;
      } else {
        // Pacote: cada ficheiro em PDF, juntos pela ordem escolhida.
        const sources = [];
        for (const [i, it] of items.entries()) {
          setBusy(fileKind(it.file) === "docx" ? `A converter ${i + 1} de ${items.length}…` : `A preparar ${i + 1} de ${items.length}…`);
          sources.push({ kind: "new" as const, name: it.name, bytes: await fileToPdf(doc.id, base, it.file) });
        }
        setBusy("A juntar os documentos…");
        const pkg = await buildPackage(null, [], sources);
        parts = pkg.parts;
        pdfBytes = pkg.bytes.slice().buffer;
        setBusy("A carregar o pacote…");
        const up = await supabase.storage.from(BUCKET).upload(`${base}/original.pdf`, new Blob([pkg.bytes], { type: "application/pdf" }), { contentType: "application/pdf", upsert: true });
        if (up.error) throw up.error;
      }
      const pdf = await openPdf(pdfBytes);
      const pages = await pageSizes(pdf);
      const { error: ue } = await supabase
        .from("documents")
        .update({ original_path: `${base}/original.pdf`, page_count: pages.length, pages, parts })
        .eq("id", doc.id);
      if (ue) throw ue;
      nav(`/documentos/${doc.id}/editar`, { replace: true });
    } catch (e) {
      if (docId) await supabase.rpc("delete_draft_document", { p_document_id: docId });
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  const wsFolders = folders.filter((f) => f.workspace_id === ws);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 lg:py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{asTemplate ? "Novo modelo" : "Novo documento"}</h1>
      <p className="muted mt-1">
        {asTemplate
          ? "Carregue o documento base. A seguir indica os papéis de quem assina (ex.: Colaborador, Diretor do hotel) e onde."
          : "Carregue um ou mais documentos. A seguir indica quem assina e onde."}
      </p>

      <div className="card mt-6 p-5 sm:p-6">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pick(e.dataTransfer.files);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 text-center transition ${items.length ? "py-5" : "py-10"} ${drag ? "border-navy-500 bg-navy-50" : "border-slate-300 bg-slate-50 hover:bg-slate-100"}`}
        >
          <UploadIcon className="h-8 w-8 text-slate-400" />
          {items.length ? (
            <p className="mt-2 font-medium text-slate-900">Adicionar mais documentos ao pacote</p>
          ) : (
            <>
              <p className="mt-3 font-medium text-slate-900">Arraste os ficheiros para aqui ou clique para escolher</p>
              <p className="muted">PDF ou Word (.docx), até 25 MB. Vários ficheiros formam um pacote assinado de uma só vez.</p>
            </>
          )}
          <input type="file" multiple accept=".pdf,.docx,application/pdf" className="sr-only" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
        </label>

        {items.length > 0 && (
          <div className="mt-4">
            {items.length > 1 && (
              <p className="mb-2 text-sm text-slate-600">
                <span className="font-medium text-slate-900">Pacote com {items.length} documentos.</span> Os signatários recebem um só convite e assinam tudo de uma vez; no fim, cada documento fica também disponível em separado.
              </p>
            )}
            <ol className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {items.map((it, i) => (
                <li key={it.key} className="flex items-center gap-2 px-3 py-2">
                  <span className="w-5 text-right text-xs font-medium text-slate-400 tabular-nums">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    {items.length > 1 ? (
                      <input
                        className="input py-1"
                        value={it.name}
                        maxLength={150}
                        aria-label={`Nome do documento ${i + 1}`}
                        onChange={(e) => setItems(items.map((x) => (x.key === it.key ? { ...x, name: e.target.value } : x)))}
                      />
                    ) : (
                      <p className="truncate text-sm font-medium text-slate-900">{it.file.name}</p>
                    )}
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {items.length > 1 && `${it.file.name} · `}
                      {(it.file.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                  {items.length > 1 && (
                    <>
                      <button className="btn-ghost px-1.5" onClick={() => moveItem(i, -1)} disabled={i === 0 || !!busy} aria-label="Subir"><ArrowUp className="h-4 w-4" /></button>
                      <button className="btn-ghost px-1.5" onClick={() => moveItem(i, 1)} disabled={i === items.length - 1 || !!busy} aria-label="Descer"><ArrowDown className="h-4 w-4" /></button>
                    </>
                  )}
                  <button className="btn-ghost px-1.5 text-red-600" onClick={() => setItems(items.filter((x) => x.key !== it.key))} disabled={!!busy} aria-label="Retirar"><TrashIcon className="h-4 w-4" /></button>
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="mt-5 space-y-4">
          <div>
            <label className="label" htmlFor="title">Título</label>
            <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={asTemplate ? "Ex.: Contrato de trabalho a termo" : "Ex.: Contrato de fornecimento — Lavandaria"} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {workspaces.length > 1 && (
              <div>
                <label className="label" htmlFor="ws">Espaço de trabalho</label>
                <select id="ws" className="input" value={ws} onChange={(e) => { setWs(e.target.value); setFolder(""); }}>
                  {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="label" htmlFor="folder">Pasta (opcional)</label>
              <select id="folder" className="input" value={folder} onChange={(e) => setFolder(e.target.value)}>
                <option value="">Sem pasta</option>
                {wsFolders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          </div>
        </div>

        {error && <div className="mt-4"><Alert>{error}</Alert></div>}

        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => nav(-1)} disabled={!!busy}>Cancelar</button>
          <button className="btn-primary" onClick={create} disabled={!items.length || items.some((x) => !x.name.trim()) || !title.trim() || !ws || !!busy}>
            {busy ? <><Spinner className="h-4 w-4 text-white" /> {busy}</> : "Continuar"}
          </button>
        </div>
      </div>
    </div>
  );
}
