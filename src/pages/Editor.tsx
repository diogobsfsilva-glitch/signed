import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { supabase, BUCKET } from "../lib/supabase";
import { documentAction } from "../lib/api";
import { instantiate } from "../lib/templates";
import type { DocumentRow, FieldRow, FieldType, RecipientRow } from "../../supabase/functions/_shared/types";
import { AUTO_FIELD_TYPES, FIELD_LABELS, isAutoField, isPrefillable } from "../../supabase/functions/_shared/types";
import { validateForSend } from "../../supabase/functions/_shared/workflow";
import { PdfPages } from "../components/PdfPages";
import { DEFAULT_SIZE, fieldIcon } from "../components/FieldBox";
import { Alert, ArrowDown, ArrowUp, FullPageSpinner, IdIcon, Modal, PlusIcon, Spinner, TrashIcon, toast } from "../components/ui";
import { errorMessage, RECIPIENT_COLORS } from "../lib/format";

type R = Pick<RecipientRow, "id" | "name" | "email" | "role" | "signing_order" | "civil_id" | "color" | "status">;
type F = Pick<FieldRow, "id" | "recipient_id" | "type" | "page" | "x" | "y" | "w" | "h" | "required" | "label" | "options" | "group_name" | "value"> & { readonly: boolean };
type Tab = "recipients" | "fields" | "settings";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function Editor() {
  const { id } = useParams();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [recipients, setRecipients] = useState<R[]>([]);
  const [fields, setFields] = useState<F[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("recipients");
  const [activeRecipient, setActiveRecipient] = useState<string | null>(null);
  const [placing, setPlacing] = useState<FieldType | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(0);
  const [review, setReview] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const track = useCallback(async <T,>(p: PromiseLike<{ error: unknown } & T>): Promise<T & { error: unknown }> => {
    setSaving((n) => n + 1);
    try {
      const r = await p;
      if (r.error) toast(errorMessage(r.error), "error");
      return r;
    } finally {
      setSaving((n) => n - 1);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const { data: d } = await supabase.from("documents").select("*").eq("id", id!).maybeSingle();
      if (!d) return setNotFound(true);
      if (d.status !== "draft") return nav(`/documentos/${d.id}`, { replace: true });
      const [{ data: r }, { data: f }, { data: url }] = await Promise.all([
        supabase.from("recipients").select("id, name, email, role, signing_order, civil_id, color, status").eq("document_id", d.id).order("signing_order").order("created_at"),
        supabase.from("fields").select("id, recipient_id, type, page, x, y, w, h, required, label, options, group_name, value, readonly").eq("document_id", d.id),
        supabase.storage.from(BUCKET).createSignedUrl(d.original_path, 3600),
      ]);
      setDoc(d);
      setRecipients(r ?? []);
      setFields(f ?? []);
      setPdfUrl(url?.signedUrl ?? null);
      setActiveRecipient(r?.find((x) => x.role === "signer")?.id ?? null);
      if (r && r.length) setTab("fields");
      if (params.get("rever") === "1" && !d.is_template) setReview(true);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nav]);

  const signers = useMemo(() => recipients.filter((r) => r.role === "signer"), [recipients]);
  const colorOf = useCallback((rid: string) => recipients.find((r) => r.id === rid)?.color ?? "#64748b", [recipients]);
  const selectedField = fields.find((f) => f.id === selected) ?? null;

  // ------------------------------------------------------------------ documento
  async function patchDoc(patch: Partial<DocumentRow>) {
    setDoc((d) => (d ? { ...d, ...patch } : d));
    await track(supabase.from("documents").update(patch).eq("id", doc!.id));
  }

  // ------------------------------------------------------------------ destinatários
  async function addRecipient(r: { name: string; email: string; role: "signer" | "cc"; civil_id: string | null }) {
    const used = new Set(recipients.map((x) => x.color));
    const color = RECIPIENT_COLORS.find((c) => !used.has(c)) ?? RECIPIENT_COLORS[recipients.length % RECIPIENT_COLORS.length];
    const row: R = {
      id: crypto.randomUUID(),
      name: r.name.trim(),
      email: r.email.trim().toLowerCase(),
      role: r.role,
      civil_id: r.civil_id,
      signing_order: Math.max(0, ...recipients.map((x) => x.signing_order)) + 1,
      color,
      status: "pending",
    };
    const res = await track(supabase.from("recipients").insert({ ...row, status: undefined, document_id: doc!.id }));
    if (!res.error) {
      setRecipients((x) => [...x, row]);
      if (row.role === "signer" && !activeRecipient) setActiveRecipient(row.id);
    }
  }

  async function updateRecipient(rid: string, patch: Partial<R>) {
    setRecipients((x) => x.map((r) => (r.id === rid ? { ...r, ...patch } : r)));
    await track(supabase.from("recipients").update(patch).eq("id", rid));
  }

  async function removeRecipient(rid: string) {
    const n = fields.filter((f) => f.recipient_id === rid).length;
    if (n && !confirm(`Remover este destinatário apaga também os ${n} campos dele. Continuar?`)) return;
    const res = await track(supabase.from("recipients").delete().eq("id", rid));
    if (!res.error) {
      setRecipients((x) => x.filter((r) => r.id !== rid));
      setFields((x) => x.filter((f) => f.recipient_id !== rid));
      if (activeRecipient === rid) setActiveRecipient(signers.find((s) => s.id !== rid)?.id ?? null);
    }
  }

  async function move(rid: string, dir: -1 | 1) {
    const ordered = [...recipients].sort((a, b) => a.signing_order - b.signing_order);
    const i = ordered.findIndex((r) => r.id === rid);
    const j = i + dir;
    if (j < 0 || j >= ordered.length) return;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    const renum = ordered.map((r, k) => ({ ...r, signing_order: k + 1 }));
    setRecipients(renum);
    await Promise.all(renum.map((r) => track(supabase.from("recipients").update({ signing_order: r.signing_order }).eq("id", r.id))));
  }

  // ------------------------------------------------------------------ campos
  async function placeField(page: number, x: number, y: number) {
    if (!placing || !activeRecipient || !doc?.pages) return;
    const ps = doc.pages[page - 1];
    const size = DEFAULT_SIZE[placing];
    const w = Math.min(0.9, size.w / ps.w);
    const h = Math.min(0.5, size.h / ps.h);
    const f: F = {
      id: crypto.randomUUID(),
      recipient_id: activeRecipient,
      type: placing,
      page,
      x: clamp(x - w / 2, 0, 1 - w),
      y: clamp(y - h / 2, 0, 1 - h),
      w,
      h,
      required: placing !== "checkbox" && !isAutoField(placing),
      label: null,
      options: placing === "radio" || placing === "dropdown" ? ["Opção 1", "Opção 2"] : null,
      group_name: null,
      value: null,
      readonly: false,
    };
    setFields((x) => [...x, f]);
    setSelected(f.id);
    setPlacing(null);
    const res = await track(supabase.from("fields").insert({ ...f, document_id: doc.id }));
    if (res.error) setFields((x) => x.filter((y) => y.id !== f.id));
  }

  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  function updateField(fid: string, patch: Partial<F>, immediate = false) {
    setFields((x) => x.map((f) => (f.id === fid ? { ...f, ...patch } : f)));
    const run = () => track(supabase.from("fields").update(patch).eq("id", fid));
    clearTimeout(pending.current.get(fid));
    if (immediate) run();
    else pending.current.set(fid, setTimeout(run, 400));
  }

  async function deleteField(fid: string) {
    setFields((x) => x.filter((f) => f.id !== fid));
    setSelected(null);
    await track(supabase.from("fields").delete().eq("id", fid));
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!selected) return;
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteField(selected);
      }
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Arrastar / redimensionar
  function startDrag(e: React.PointerEvent, f: F, mode: "move" | "resize", size: { width: number; height: number }) {
    e.stopPropagation();
    e.preventDefault();
    setSelected(f.id);
    const sx = e.clientX;
    const sy = e.clientY;
    const start = { ...f };
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / size.width;
      const dy = (ev.clientY - sy) / size.height;
      if (mode === "move") {
        setFields((x) => x.map((y) => (y.id === f.id ? { ...y, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) } : y)));
      } else {
        setFields((x) =>
          x.map((y) => (y.id === f.id ? { ...y, w: clamp(start.w + dx, 0.015, 1 - start.x), h: clamp(start.h + dy, 0.01, 1 - start.y) } : y)),
        );
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const cur = fieldsRef.current.find((y) => y.id === f.id);
      if (cur && (cur.x !== start.x || cur.y !== start.y || cur.w !== start.w || cur.h !== start.h)) {
        track(supabase.from("fields").update({ x: cur.x, y: cur.y, w: cur.w, h: cur.h }).eq("id", f.id));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  if (notFound) return <div className="p-8"><Alert>Documento não encontrado.</Alert></div>;
  if (!doc) return <FullPageSpinner />;
  const isTemplate = doc.is_template;
  const home = isTemplate ? "/modelos" : "/";

  async function saveAsTemplate() {
    const name = prompt("Nome do modelo:", doc!.title);
    if (!name?.trim()) return;
    try {
      const tid = await instantiate({ sourceId: doc!.id, sourcePath: doc!.original_path!, asTemplate: true, title: name.trim(), workspaceId: doc!.workspace_id });
      toast("Modelo criado. Pode ajustar os papéis e os campos.");
      nav(`/documentos/${tid}/editar`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }

  const issues = validateForSend(doc, recipients, fields.map((f) => ({ ...f })));
  const palette: FieldType[] = doc.signature_mode === "qualified"
    ? ["signature", "text", "date", "checkbox", "radio", "dropdown", "attachment"]
    : ["signature", "initials", "text", "date", "checkbox", "radio", "dropdown", "attachment"];
  const paletteButton = (t: FieldType) => (
    <button
      key={t}
      onClick={() => setPlacing(placing === t ? null : t)}
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm ${placing === t ? "border-navy-600 bg-navy-900 text-white" : "border-slate-200 bg-white hover:bg-slate-50"}`}
    >
      <span className="w-5 text-center text-xs">{fieldIcon(t)}</span>
      {t === "signature" && doc.signature_mode === "qualified" ? "Assinatura CC" : FIELD_LABELS[t]}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Barra superior */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <Link to={home} className="btn-ghost px-2" aria-label="Voltar">←</Link>
        {isTemplate && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Modelo</span>}
        <input
          className="min-w-0 flex-1 rounded-md border border-transparent px-2 py-1 text-base font-semibold hover:border-slate-200 focus:border-navy-500 focus:outline-none"
          value={doc.title}
          maxLength={200}
          onChange={(e) => setDoc({ ...doc, title: e.target.value })}
          onBlur={(e) => e.target.value.trim() && patchDoc({ title: e.target.value.trim() })}
          aria-label="Título"
        />
        <span className="hidden text-xs text-slate-400 sm:inline">{saving ? "A guardar…" : "Guardado"}</span>
        <button
          className="btn-ghost text-red-700"
          onClick={async () => {
            if (!confirm(isTemplate ? "Apagar este modelo? Os documentos já criados a partir dele não são afetados." : "Apagar este rascunho?")) return;
            const { error } = await supabase.rpc("delete_draft_document", { p_document_id: doc.id });
            if (error) toast(errorMessage(error), "error");
            else nav(home);
          }}
        >
          Apagar
        </button>
        {isTemplate ? (
          <Link to="/modelos" className="btn-primary">Concluído</Link>
        ) : (
          <>
            <button className="btn-ghost hidden sm:inline-flex" onClick={saveAsTemplate} disabled={!doc.original_path}>Guardar como modelo</button>
            <button className="btn-primary" onClick={() => setReview(true)}>Rever e enviar</button>
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Painel lateral */}
        <aside className="max-h-[45vh] shrink-0 overflow-y-auto border-b border-slate-200 bg-white lg:max-h-none lg:w-80 lg:border-r lg:border-b-0">
          <div className="sticky top-0 z-10 flex border-b border-slate-200 bg-white text-sm">
            {([
              ["recipients", `Destinatários (${recipients.length})`],
              ["fields", "Campos"],
              ["settings", "Opções"],
            ] as [Tab, string][]).map(([t, l]) => (
              <button key={t} onClick={() => setTab(t)} className={`flex-1 border-b-2 px-2 py-2.5 font-medium ${tab === t ? "border-navy-900 text-navy-900" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
                {l}
              </button>
            ))}
          </div>
          <div className="p-4">
            {tab === "recipients" && (
              <RecipientsPanel
                doc={doc}
                recipients={recipients}
                onAdd={addRecipient}
                onUpdate={updateRecipient}
                onRemove={removeRecipient}
                onMove={move}
                onDone={() => setTab("fields")}
              />
            )}
            {tab === "fields" && (
              <div className="space-y-5">
                {signers.length === 0 ? (
                  <Alert kind="info">Adicione primeiro quem vai assinar, no separador Destinatários.</Alert>
                ) : (
                  <>
                    <div>
                      <label className="label">Campos para</label>
                      <div className="flex flex-col gap-1.5">
                        {signers.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => setActiveRecipient(s.id)}
                            className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm ${activeRecipient === s.id ? "border-navy-500 bg-navy-50" : "border-slate-200 hover:bg-slate-50"}`}
                          >
                            <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: s.color }} />
                            <span className="min-w-0 flex-1 truncate">{s.name}</span>
                            <span className="text-xs text-slate-400">{fields.filter((f) => f.recipient_id === s.id).length}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="label">Adicionar campo</label>
                      <p className="mb-2 text-xs text-slate-500">Escolha o tipo e clique no documento onde o quer colocar.</p>
                      <div className="grid grid-cols-2 gap-1.5">{palette.map(paletteButton)}</div>
                      <p className="mt-3 mb-1.5 text-xs font-medium text-slate-500">Preenchidos automaticamente</p>
                      <div className="grid grid-cols-2 gap-1.5">{AUTO_FIELD_TYPES.map(paletteButton)}</div>
                      {doc.signature_mode === "qualified" && (
                        <p className="mt-2 text-xs text-slate-500">No modo Cartão de Cidadão, o campo de assinatura indica onde o signatário deve colocar a assinatura na app Autenticação.gov.</p>
                      )}
                    </div>
                    {selectedField && (
                      <FieldProps field={selectedField} signers={signers} qualified={doc.signature_mode === "qualified"} onChange={(p, now) => updateField(selectedField.id, p, now)} onDelete={() => deleteField(selectedField.id)} />
                    )}
                  </>
                )}
              </div>
            )}
            {tab === "settings" && <SettingsPanel doc={doc} onPatch={patchDoc} hasInitials={fields.some((f) => f.type === "initials")} />}
          </div>
        </aside>

        {/* Documento */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-100 px-3 py-6 sm:px-8" onClick={() => setSelected(null)}>
          {placing && (
            <div className="sticky top-0 z-20 mx-auto mb-3 w-fit rounded-full bg-navy-900 px-4 py-1.5 text-sm text-white shadow-lg">
              Clique no documento para colocar «{FIELD_LABELS[placing]}» · <button className="underline" onClick={(e) => { e.stopPropagation(); setPlacing(null); }}>cancelar</button>
            </div>
          )}
          <div className="mx-auto max-w-[860px]">
            <PdfPages
              src={pdfUrl}
              cursor={placing ? "crosshair" : undefined}
              onPageClick={(page, x, y, e) => {
                if (!placing) return;
                e.stopPropagation();
                placeField(page, x, y);
              }}
              overlay={(page, size) =>
                fields
                  .filter((f) => f.page === page)
                  .map((f) => {
                    const color = colorOf(f.recipient_id);
                    const sel = f.id === selected;
                    const who = recipients.find((r) => r.id === f.recipient_id)?.name ?? "";
                    return (
                      <div
                        key={f.id}
                        className={`group absolute flex cursor-move select-none items-center overflow-hidden rounded-[3px] border text-[11px] font-medium ${sel ? "ring-2 ring-offset-1" : ""}`}
                        style={{
                          left: `${f.x * 100}%`,
                          top: `${f.y * 100}%`,
                          width: `${f.w * 100}%`,
                          height: `${f.h * 100}%`,
                          borderColor: color,
                          background: `${color}1f`,
                          color,
                          // @ts-expect-error variável CSS
                          "--tw-ring-color": color,
                        }}
                        onPointerDown={(e) => startDrag(e, f, "move", size)}
                        onClick={(e) => e.stopPropagation()}
                        title={`${FIELD_LABELS[f.type]} · ${who}`}
                      >
                        <span className="truncate px-1">
                          {fieldIcon(f.type)} {f.label || (f.type === "signature" && doc.signature_mode === "qualified" ? "Assinatura CC" : FIELD_LABELS[f.type])}
                          {f.required && f.type !== "checkbox" && !isAutoField(f.type) && !f.readonly ? " *" : ""}
                          {f.value ? <span className="font-normal text-slate-700"> = {f.type === "checkbox" ? (f.value === "true" ? "✓" : "—") : f.value}</span> : null}
                          {f.readonly ? " 🔒" : ""}
                        </span>
                        <span
                          className="absolute right-0 bottom-0 h-2.5 w-2.5 cursor-se-resize opacity-0 group-hover:opacity-100"
                          style={{ background: color, opacity: sel ? 1 : undefined }}
                          onPointerDown={(e) => startDrag(e, f, "resize", size)}
                        />
                      </div>
                    );
                  })
              }
            />
          </div>
        </div>
      </div>

      <ReviewModal open={review} onClose={() => setReview(false)} doc={doc} recipients={recipients} fields={fields} issues={issues.map((i) => i.message)} onSent={() => nav(`/documentos/${doc.id}`)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
function RecipientsPanel({
  doc,
  recipients,
  onAdd,
  onUpdate,
  onRemove,
  onMove,
  onDone,
}: {
  doc: DocumentRow;
  recipients: R[];
  onAdd: (r: { name: string; email: string; role: "signer" | "cc"; civil_id: string | null }) => Promise<void>;
  onUpdate: (id: string, p: Partial<R>) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const tpl = doc.is_template;
  const [role, setRole] = useState<"signer" | "cc">("signer");
  const [civil, setCivil] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const ordered = [...recipients].sort((a, b) => a.signing_order - b.signing_order);
  const q = doc.signature_mode === "qualified";

  return (
    <div className="space-y-5">
      <ol className="space-y-2">
        {ordered.map((r, i) => (
          <li key={r.id} className="rounded-lg border border-slate-200 p-2.5">
            <div className="flex items-start gap-2">
              <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: r.color }}>
                {doc.sequential ? i + 1 : "•"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.name}</p>
                <p className="truncate text-xs text-slate-500">{r.email || (tpl ? "Email indicado ao usar o modelo" : "Sem email")}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <select className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs" value={r.role} onChange={(e) => onUpdate(r.id, { role: e.target.value as "signer" | "cc" })} aria-label="Papel">
                    <option value="signer">Assina</option>
                    <option value="cc">Recebe cópia</option>
                  </select>
                  {q && r.role === "signer" && (
                    <input
                      className="w-32 rounded border border-slate-200 px-1.5 py-0.5 text-xs"
                      placeholder="Nº id. civil (opc.)"
                      defaultValue={r.civil_id ?? ""}
                      inputMode="numeric"
                      onBlur={(e) => {
                        const v = e.target.value.replace(/\D/g, "");
                        if (v && (v.length < 6 || v.length > 9)) return toast("O nº de identificação civil tem entre 6 e 9 dígitos.", "error");
                        onUpdate(r.id, { civil_id: v || null });
                      }}
                      aria-label="Número de identificação civil"
                    />
                  )}
                </div>
              </div>
              <div className="flex flex-col">
                <button className="rounded p-0.5 text-slate-400 hover:text-slate-800 disabled:opacity-30" disabled={i === 0} onClick={() => onMove(r.id, -1)} aria-label="Subir"><ArrowUp className="h-4 w-4" /></button>
                <button className="rounded p-0.5 text-slate-400 hover:text-slate-800 disabled:opacity-30" disabled={i === ordered.length - 1} onClick={() => onMove(r.id, 1)} aria-label="Descer"><ArrowDown className="h-4 w-4" /></button>
              </div>
              <button className="rounded p-1 text-slate-400 hover:text-red-600" onClick={() => onRemove(r.id)} aria-label="Remover"><TrashIcon className="h-4 w-4" /></button>
            </div>
          </li>
        ))}
      </ol>

      <form
        className="space-y-2.5 rounded-lg bg-slate-50 p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          if (email.trim() && recipients.some((r) => r.email === email.trim().toLowerCase())) return setErr("Esse email já está na lista.");
          const c = civil.replace(/\D/g, "");
          if (c && (c.length < 6 || c.length > 9)) return setErr("O nº de identificação civil tem entre 6 e 9 dígitos.");
          await onAdd({ name, email, role, civil_id: c || null });
          setName("");
          setEmail("");
          setCivil("");
        }}
      >
        <p className="text-sm font-medium">{tpl ? "Adicionar papel" : "Adicionar destinatário"}</p>
        {tpl && <p className="text-xs text-slate-500">Indique o papel (ex.: Colaborador, Diretor do hotel). O nome e o email pedem-se ao usar o modelo; preencha o email só se for sempre a mesma pessoa.</p>}
        <input className="input" placeholder={tpl ? "Papel (ex.: Colaborador)" : "Nome completo"} value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        <input className="input" type="email" placeholder={tpl ? "Email (opcional)" : "email@exemplo.pt"} value={email} onChange={(e) => setEmail(e.target.value)} required={!tpl} />
        <div className="flex gap-2">
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as "signer" | "cc")} aria-label="Papel">
            <option value="signer">Assina</option>
            <option value="cc">Recebe cópia</option>
          </select>
          {q && role === "signer" && <input className="input" placeholder="Nº id. civil (opc.)" value={civil} onChange={(e) => setCivil(e.target.value)} inputMode="numeric" />}
        </div>
        {q && role === "signer" && (
          <p className="text-xs text-slate-500">
            <IdIcon className="mr-1 inline h-3.5 w-3.5" />
            O Signed confirma que quem assina é esta pessoa: pelo nº de identificação civil (se indicado) ou pelo nome no cartão.
          </p>
        )}
        {err && <Alert>{err}</Alert>}
        <button className="btn-secondary w-full"><PlusIcon className="h-4 w-4" /> Adicionar</button>
      </form>
      {recipients.some((r) => r.role === "signer") && (
        <button className="btn-primary w-full" onClick={onDone}>Seguinte: colocar campos</button>
      )}
    </div>
  );
}

function FieldProps({ field, signers, qualified, onChange, onDelete }: { field: F; signers: R[]; qualified: boolean; onChange: (p: Partial<F>, now?: boolean) => void; onDelete: () => void }) {
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{field.type === "signature" && qualified ? "Assinatura CC" : FIELD_LABELS[field.type]}</p>
        <button className="btn-ghost px-2 py-1 text-red-700" onClick={onDelete}><TrashIcon className="h-4 w-4" /> Apagar</button>
      </div>
      <div>
        <label className="label text-xs">Quem preenche</label>
        <select className="input" value={field.recipient_id} onChange={(e) => onChange({ recipient_id: e.target.value }, true)}>
          {signers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      {isAutoField(field.type) && (
        <p className="rounded-md bg-slate-50 p-2 text-xs text-slate-600">
          {field.type === "signed_date"
            ? "Fica com a data em que a pessoa assina (no modo Cartão de Cidadão, a data em que o PDF é preparado para assinar)."
            : `Fica com o ${field.type === "name" ? "nome" : "email"} do signatário, tal como está no documento.`}
        </p>
      )}
      {field.type !== "signature" && field.type !== "initials" && !isAutoField(field.type) && (
        <div>
          <label className="label text-xs">Nome do campo</label>
          <input className="input" value={field.label ?? ""} maxLength={80} placeholder={field.type === "attachment" ? "Ex.: Cópia do documento de identificação" : "Ex.: NIF, Cargo, Morada"} onChange={(e) => onChange({ label: e.target.value || null })} />
        </div>
      )}
      {field.type === "attachment" && (
        <p className="text-xs text-slate-500">O signatário carrega um PDF ou uma imagem (até 10 MB). O ficheiro fica junto do documento e é arquivado com ele.</p>
      )}
      {(field.type === "radio" || field.type === "dropdown") && (
        <div>
          <label className="label text-xs">Opções (uma por linha)</label>
          <textarea
            className="input min-h-20"
            defaultValue={(field.options ?? []).join("\n")}
            onBlur={(e) => onChange({ options: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20) }, true)}
          />
        </div>
      )}
      {isPrefillable(field.type) && <PrefillEditor field={field} onChange={onChange} />}
      {field.type !== "signature" && !isAutoField(field.type) && !field.readonly && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={field.required} onChange={(e) => onChange({ required: e.target.checked }, true)} />
          Obrigatório
        </label>
      )}
      <p className="text-xs text-slate-400">Arraste para mover; use o canto inferior direito para redimensionar. Tecla Delete apaga.</p>
    </div>
  );
}

/** Valor que o remetente preenche antes de enviar (opcionalmente fixo). */
function PrefillEditor({ field, onChange }: { field: F; onChange: (p: Partial<F>, now?: boolean) => void }) {
  const set = (v: string, now = true) => onChange({ value: v === "" ? null : v }, now);
  let input: React.ReactNode;
  switch (field.type) {
    case "date":
      input = <input type="date" className="input" value={field.value ?? ""} onChange={(e) => set(e.target.value)} />;
      break;
    case "checkbox":
      input = (
        <select className="input" value={field.value ?? ""} onChange={(e) => set(e.target.value)}>
          <option value="">Sem valor</option>
          <option value="true">Marcada</option>
          <option value="false">Não marcada</option>
        </select>
      );
      break;
    case "radio":
    case "dropdown":
      input = (
        <select className="input" value={field.value ?? ""} onChange={(e) => set(e.target.value)}>
          <option value="">Sem valor</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
      break;
    default:
      input = <input className="input" value={field.value ?? ""} maxLength={500} placeholder="Deixe vazio para o signatário preencher" onChange={(e) => set(e.target.value, false)} />;
  }
  return (
    <div className="space-y-2 rounded-md bg-slate-50 p-2">
      <label className="label text-xs">Valor pré-preenchido (opcional)</label>
      {input}
      <label className="flex items-start gap-2 text-xs text-slate-600">
        <input type="checkbox" className="mt-0.5" checked={field.readonly} onChange={(e) => onChange({ readonly: e.target.checked }, true)} />
        <span>Fixo: o signatário vê o valor mas não o pode alterar (ex.: vencimento, hotel, função).</span>
      </label>
    </div>
  );
}

function SettingsPanel({ doc, onPatch, hasInitials }: { doc: DocumentRow; onPatch: (p: Partial<DocumentRow>) => void; hasInitials: boolean }) {
  const toLocal = (s: string | null) => (s ? new Date(s).toISOString().slice(0, 10) : "");
  return (
    <div className="space-y-6">
      <fieldset>
        <legend className="label">Tipo de assinatura</legend>
        <div className="space-y-2">
          {([
            ["simple", "Assinatura simples", "O signatário desenha ou escreve a assinatura. Acesso confirmado por código enviado por email. Indicado para fornecedores estrangeiros, hóspedes e documentos correntes."],
            ["qualified", "Cartão de Cidadão (qualificada)", "Assinatura com Cartão de Cidadão ou Chave Móvel Digital na app Autenticação.gov. Tem o mesmo valor que a assinatura manuscrita (eIDAS)."],
          ] as const).map(([v, t, d]) => (
            <label key={v} className={`block cursor-pointer rounded-lg border p-3 ${doc.signature_mode === v ? "border-navy-500 bg-navy-50" : "border-slate-200 hover:bg-slate-50"}`}>
              <div className="flex items-center gap-2">
                <input type="radio" name="mode" checked={doc.signature_mode === v} onChange={() => onPatch({ signature_mode: v })} />
                <span className="text-sm font-medium">{t}</span>
              </div>
              <p className="mt-1 pl-6 text-xs text-slate-500">{d}</p>
            </label>
          ))}
        </div>
        {doc.signature_mode === "qualified" && hasInitials && <div className="mt-2"><Alert kind="warning">Há campos de iniciais: apague-os, porque não existem no modo Cartão de Cidadão.</Alert></div>}
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={doc.sequential} onChange={(e) => onPatch({ sequential: e.target.checked })} />
        <span>
          <span className="font-medium">Ordem de assinatura</span>
          <span className="block text-xs text-slate-500">Cada pessoa só recebe o documento depois da anterior. Desligado: todos recebem ao mesmo tempo{doc.signature_mode === "qualified" ? " (as assinaturas CC são sempre feitas uma de cada vez)" : ""}.</span>
        </span>
      </label>

      <div className="grid grid-cols-2 gap-3">
        {!doc.is_template && <div>
          <label className="label" htmlFor="exp">Prazo (opcional)</label>
          <input id="exp" type="date" className="input" min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} value={toLocal(doc.expires_at)} onChange={(e) => onPatch({ expires_at: e.target.value ? new Date(`${e.target.value}T23:59:00`).toISOString() : null })} />
        </div>}
        <div>
          <label className="label" htmlFor="rem">Lembretes</label>
          <select id="rem" className="input" value={doc.reminder_days} onChange={(e) => onPatch({ reminder_days: Number(e.target.value) })}>
            <option value={0}>Nunca</option>
            <option value={1}>Diários</option>
            <option value={2}>A cada 2 dias</option>
            <option value={3}>A cada 3 dias</option>
            <option value={7}>Semanais</option>
          </select>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="subj">Assunto do email (opcional)</label>
        <input id="subj" className="input" defaultValue={doc.subject ?? ""} maxLength={200} onBlur={(e) => onPatch({ subject: e.target.value.trim() || null })} placeholder="Gerado automaticamente se vazio" />
      </div>
      <div>
        <label className="label" htmlFor="msg">Mensagem</label>
        <textarea id="msg" className="input min-h-24" defaultValue={doc.message ?? ""} maxLength={2000} onBlur={(e) => onPatch({ message: e.target.value.trim() || null })} placeholder="Ex.: Segue o contrato para assinatura. Qualquer dúvida, contacte-me." />
      </div>
    </div>
  );
}

function ReviewModal({ open, onClose, doc, recipients, fields, issues, onSent }: { open: boolean; onClose: () => void; doc: DocumentRow; recipients: R[]; fields: F[]; issues: string[]; onSent: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ordered = [...recipients].sort((a, b) => a.signing_order - b.signing_order);
  return (
    <Modal open={open} onClose={onClose} title="Rever e enviar" wide>
      {issues.length > 0 ? (
        <Alert kind="warning">{"Antes de enviar:\n• " + issues.join("\n• ")}</Alert>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-slate-600">
            <span><strong className="text-slate-900">Tipo:</strong> {doc.signature_mode === "qualified" ? "Cartão de Cidadão (qualificada)" : "Assinatura simples"}</span>
            <span><strong className="text-slate-900">Ordem:</strong> {doc.sequential ? "sequencial" : "em simultâneo"}</span>
            {doc.expires_at && <span><strong className="text-slate-900">Prazo:</strong> {new Date(doc.expires_at).toLocaleDateString("pt-PT")}</span>}
          </div>
          <ol className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {ordered.map((r, i) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                <span className="w-5 text-center text-xs text-slate-400">{r.role === "signer" && doc.sequential ? i + 1 : ""}</span>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />
                <span className="min-w-0 flex-1 truncate">{r.name} <span className="text-slate-400">· {r.email}</span></span>
                <span className="text-xs text-slate-500">{r.role === "signer" ? `${fields.filter((f) => f.recipient_id === r.id).length} campos` : "cópia"}</span>
              </li>
            ))}
          </ol>
          {doc.signature_mode === "qualified" && (
            <Alert kind="info">
              Os signatários recebem um email, confirmam o acesso com um código e preenchem os campos. Depois, um de cada vez, descarregam o PDF, assinam-no com o Cartão de Cidadão ou a Chave Móvel Digital na app Autenticação.gov e voltam a carregá-lo no Signed.
            </Alert>
          )}
        </div>
      )}
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>Voltar</button>
        <button
          className="btn-primary"
          disabled={issues.length > 0 || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await documentAction("send", doc.id);
              toast("Documento enviado.");
              onSent();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner className="h-4 w-4 text-white" /> : null} Enviar
        </button>
      </div>
    </Modal>
  );
}
