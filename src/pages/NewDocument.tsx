import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase, BUCKET } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { convertDocx } from "../lib/api";
import { openPdf, pageSizes } from "../lib/pdf";
import { Alert, Spinner, UploadIcon } from "../components/ui";
import { errorMessage } from "../lib/format";

const MAX = 25 * 1024 * 1024;

export function NewDocument() {
  const { profile, workspaces } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const asTemplate = params.get("modelo") === "1";
  const [file, setFile] = useState<File | null>(null);
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

  function pick(f: File | undefined) {
    if (!f) return;
    setError(null);
    const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
    const isDocx = f.name.toLowerCase().endsWith(".docx");
    if (!isPdf && !isDocx) return setError("Escolha um ficheiro PDF ou Word (.docx).");
    if (f.size > MAX) return setError("O ficheiro tem mais de 25 MB.");
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.(pdf|docx)$/i, "").replace(/[_-]+/g, " ").trim());
  }

  async function create() {
    if (!file || !profile) return;
    setError(null);
    const isDocx = file.name.toLowerCase().endsWith(".docx");
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
      if (isDocx) {
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
      } else {
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
      }
      const pdf = await openPdf(pdfBytes);
      const pages = await pageSizes(pdf);
      const { error: ue } = await supabase
        .from("documents")
        .update({ original_path: `${base}/original.pdf`, page_count: pages.length, pages })
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
          : "Carregue o documento. A seguir indica quem assina e onde."}
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
            pick(e.dataTransfer.files[0]);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${drag ? "border-navy-500 bg-navy-50" : "border-slate-300 bg-slate-50 hover:bg-slate-100"}`}
        >
          <UploadIcon className="h-8 w-8 text-slate-400" />
          {file ? (
            <>
              <p className="mt-3 font-medium text-slate-900">{file.name}</p>
              <p className="muted">{(file.size / 1024 / 1024).toFixed(2)} MB · clique para trocar</p>
            </>
          ) : (
            <>
              <p className="mt-3 font-medium text-slate-900">Arraste o ficheiro para aqui ou clique para escolher</p>
              <p className="muted">PDF ou Word (.docx), até 25 MB</p>
            </>
          )}
          <input type="file" accept=".pdf,.docx,application/pdf" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
        </label>

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
          <button className="btn-primary" onClick={create} disabled={!file || !title.trim() || !ws || !!busy}>
            {busy ? <><Spinner className="h-4 w-4 text-white" /> {busy}</> : "Continuar"}
          </button>
        </div>
      </div>
    </div>
  );
}
