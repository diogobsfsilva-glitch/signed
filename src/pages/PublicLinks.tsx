// Links públicos: formulários reutilizáveis a partir de modelos, com código QR para imprimir.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import QRCode from "qrcode";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { Alert, EmptyState, FullPageSpinner, Modal, PlusIcon, Spinner, toast } from "../components/ui";
import { errorMessage, fmtDate, relative } from "../lib/format";

export interface LinkRow {
  id: string;
  title: string;
  slug: string;
  active: boolean;
  require_email_code: boolean;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  created_at: string;
  template_id: string;
  template: { title: string } | null;
}

export const publicUrl = (slug: string) => `${window.location.origin}/f/${slug}`;

export function PublicLinks() {
  const [rows, setRows] = useState<LinkRow[] | null>(null);
  const [qr, setQr] = useState<LinkRow | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    const { data, error } = await supabase
      .from("public_links")
      .select("id, title, slug, active, require_email_code, max_uses, uses, expires_at, created_at, template_id, template:documents!public_links_template_id_fkey(title)")
      .order("created_at", { ascending: false });
    if (error) toast(errorMessage(error), "error");
    setRows((data as unknown as LinkRow[]) ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function toggle(r: LinkRow) {
    const { error } = await supabase.from("public_links").update({ active: !r.active }).eq("id", r.id);
    if (error) toast(errorMessage(error), "error");
    else load();
  }

  async function remove(r: LinkRow) {
    if (!confirm(`Apagar o link «${r.title}»? Quem tiver o link ou o QR deixa de conseguir usá-lo. Os documentos já assinados mantêm-se.`)) return;
    const { error } = await supabase.from("public_links").delete().eq("id", r.id);
    if (error) toast(errorMessage(error), "error");
    else load();
  }

  if (!rows) return <FullPageSpinner />;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Links públicos</h1>
          <p className="muted mt-0.5">Um link ou código QR que qualquer pessoa usa para preencher e assinar a sua cópia: termos do spa e da piscina, autorizações, inscrições.</p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}><PlusIcon className="h-4 w-4" /> Novo link</button>
      </div>

      <div className="mt-6">
        {rows.length === 0 ? (
          <EmptyState title="Ainda não há links públicos" action={<button className="btn-primary" onClick={() => setCreating(true)}>Criar o primeiro link</button>}>
            Comece por um modelo com um signatário sem email (quem preenche o formulário). Os outros papéis, se houver, precisam de email fixo.
          </EmptyState>
        ) : (
          <ul className="card divide-y divide-slate-100 overflow-hidden">
            {rows.map((r) => {
              const expired = r.expires_at && new Date(r.expires_at) < new Date();
              const full = r.max_uses !== null && r.uses >= r.max_uses;
              return (
                <li key={r.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{r.title}</p>
                    <p className="truncate text-xs text-slate-500">
                      Modelo: {r.template?.title ?? "—"} · {r.uses}{r.max_uses ? `/${r.max_uses}` : ""} utilizações
                      {r.require_email_code ? " · confirma email por código" : ""}
                      {r.expires_at ? ` · até ${fmtDate(r.expires_at)}` : ""} · criado {relative(r.created_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {r.active && !expired && !full ? (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">Ativo</span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{!r.active ? "Desativado" : expired ? "Expirado" : "Esgotado"}</span>
                    )}
                    <button className="btn-secondary px-2.5 py-1 text-sm" onClick={() => navigator.clipboard.writeText(publicUrl(r.slug)).then(() => toast("Link copiado."))}>Copiar link</button>
                    <button className="btn-secondary px-2.5 py-1 text-sm" onClick={() => setQr(r)}>QR</button>
                    <Link to={`/?link=${r.id}`} className="btn-ghost px-2.5 py-1 text-sm">Respostas</Link>
                    <button className="btn-ghost px-2.5 py-1 text-sm" onClick={() => toggle(r)}>{r.active ? "Desativar" : "Ativar"}</button>
                    <button className="btn-ghost px-2.5 py-1 text-sm text-red-700" onClick={() => remove(r)}>Apagar</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <QrModal link={qr} onClose={() => setQr(null)} />
      <CreateLinkModal open={creating} onClose={() => setCreating(false)} onCreated={(l) => { setCreating(false); load(); setQr(l); }} />
    </div>
  );
}

export function QrModal({ link, onClose }: { link: LinkRow | null; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (link) QRCode.toDataURL(publicUrl(link.slug), { width: 640, margin: 2, errorCorrectionLevel: "M" }).then(setSrc);
  }, [link]);
  if (!link) return null;
  const url = publicUrl(link.slug);
  return (
    <Modal open onClose={onClose} title="Código QR">
      <div className="text-center">
        <p className="font-medium">{link.title}</p>
        {src ? <img src={src} alt={`Código QR para ${link.title}`} className="mx-auto mt-3 h-64 w-64" /> : <div className="flex h-64 items-center justify-center"><Spinner /></div>}
        <p className="mt-2 break-all text-xs text-slate-500">{url}</p>
        <p className="mt-3 text-sm text-slate-600">Imprima e coloque na receção, no spa ou na piscina. Quem o ler com a câmara do telemóvel abre o formulário para assinar.</p>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button className="btn-secondary" onClick={() => navigator.clipboard.writeText(url).then(() => toast("Link copiado."))}>Copiar link</button>
        {src && (
          <a className="btn-primary" href={src} download={`QR_${link.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "link"}.png`}>
            Descarregar imagem
          </a>
        )}
      </div>
    </Modal>
  );
}

interface TemplateOption {
  id: string;
  title: string;
  workspace_id: string;
  signature_mode: "simple" | "qualified";
  recipients: { name: string; email: string; role: string; group_emails?: string[] | null }[];
}

/** Um modelo serve para link público se tiver exatamente um signatário sem email e os outros com email. */
export function linkProblem(t: Pick<TemplateOption, "recipients">): string | null {
  const open = t.recipients.filter((r) => !r.email && !r.group_emails?.length);
  if (open.length !== 1 || open[0].role !== "signer") {
    return "O modelo tem de ter exatamente um signatário sem email (quem preenche o formulário); os outros papéis precisam de email fixo.";
  }
  return null;
}

export function CreateLinkModal({ open, onClose, onCreated, templateId }: { open: boolean; onClose: () => void; onCreated: (l: LinkRow) => void; templateId?: string }) {
  const { profile } = useAuth();
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [tid, setTid] = useState("");
  const [title, setTitle] = useState("");
  const [code, setCode] = useState(false);
  const [max, setMax] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCode(false);
    setMax("");
    setUntil("");
    supabase
      .from("documents")
      .select("id, title, workspace_id, signature_mode, recipients(name, email, role, group_emails)")
      .eq("is_template", true)
      .order("title")
      .then(({ data }) => {
        const list = (data as unknown as TemplateOption[]) ?? [];
        setTemplates(list);
        const first = list.find((t) => t.id === templateId) ?? list.find((t) => !linkProblem(t)) ?? list[0];
        setTid(first?.id ?? "");
        setTitle(first?.title ?? "");
      });
  }, [open, templateId]);

  if (!open) return null;
  const t = templates.find((x) => x.id === tid);
  const problem = t ? linkProblem(t) : "Escolha um modelo.";

  async function create() {
    if (!t || !profile) return;
    setBusy(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from("public_links")
        .insert({
          workspace_id: t.workspace_id,
          owner_id: profile.id,
          template_id: t.id,
          title: title.trim(),
          require_email_code: code,
          max_uses: max ? Number(max) : null,
          expires_at: until ? new Date(`${until}T23:59:00`).toISOString() : null,
        })
        .select("id, title, slug, active, require_email_code, max_uses, uses, expires_at, created_at, template_id")
        .single();
      if (error) throw error;
      toast("Link criado.");
      onCreated({ ...(data as Omit<LinkRow, "template">), template: { title: t.title } });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Novo link público">
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="pl-t">Modelo</label>
          <select id="pl-t" className="input" value={tid} onChange={(e) => { setTid(e.target.value); setTitle(templates.find((x) => x.id === e.target.value)?.title ?? ""); }}>
            {templates.length === 0 && <option value="">Sem modelos</option>}
            {templates.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
          </select>
          {t && problem && <div className="mt-2"><Alert kind="warning">{problem}</Alert></div>}
          {t?.signature_mode === "qualified" && !problem && (
            <p className="mt-2 text-xs text-slate-500">Este modelo usa Cartão de Cidadão: quem preencher precisa do cartão ou da Chave Móvel Digital.</p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="pl-title">Título (aparece no formulário)</label>
          <input id="pl-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Ex.: Termo de responsabilidade — Spa" />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={code} onChange={(e) => setCode(e.target.checked)} />
          <span>
            <span className="font-medium">Confirmar o email com um código</span>
            <span className="block text-xs text-slate-500">Mais seguro (prova que o email é da pessoa), mas mais lento. Sem código, a pessoa assina logo e recebe o link por email.</span>
          </span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="pl-max">Máximo de utilizações</label>
            <input id="pl-max" className="input" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ""))} placeholder="Sem limite" />
          </div>
          <div>
            <label className="label" htmlFor="pl-until">Válido até</label>
            <input id="pl-until" type="date" className="input" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} />
          </div>
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancelar</button>
          <button className="btn-primary" disabled={busy || !!problem || !title.trim()} onClick={create}>{busy && <Spinner className="h-4 w-4 text-white" />} Criar link</button>
        </div>
      </div>
    </Modal>
  );
}
