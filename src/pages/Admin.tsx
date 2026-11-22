import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth, type Profile } from "../auth/AuthProvider";
import { Alert, FullPageSpinner, Modal, PlusIcon, Spinner, TrashIcon, toast } from "../components/ui";
import { BrandMark, luminance } from "../components/Brand";
import { errorMessage, fmtDate } from "../lib/format";

type Tab = "workspaces" | "users" | "settings";

interface Ws {
  id: string;
  name: string;
  created_at: string;
  workspace_members: { user_id: string; role: "admin" | "member" }[];
  brand_color: string | null;
  logo_path: string | null;
}

export function Admin() {
  const [tab, setTab] = useState<Tab>("workspaces");
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Administração</h1>
      <div className="mt-5 flex gap-1 border-b border-slate-200 text-sm">
        {([
          ["workspaces", "Espaços de trabalho"],
          ["users", "Utilizadores"],
          ["settings", "Definições"],
        ] as [Tab, string][]).map(([t, l]) => (
          <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 font-medium ${tab === t ? "border-navy-900 text-navy-900" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {l}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {tab === "workspaces" && <Workspaces />}
        {tab === "users" && <Users />}
        {tab === "settings" && <Settings />}
      </div>
    </div>
  );
}

function Workspaces() {
  const { profile, refresh } = useAuth();
  const [list, setList] = useState<Ws[] | null>(null);
  const [users, setUsers] = useState<Profile[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  async function load() {
    const [{ data: ws }, { data: u }] = await Promise.all([
      supabase.from("workspaces").select("id, name, created_at, brand_color, logo_path, workspace_members(user_id, role)").order("name"),
      supabase.from("profiles").select("id, email, full_name, role, active").order("full_name"),
    ]);
    setList((ws as Ws[]) ?? []);
    setUsers(u ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  if (!list) return <FullPageSpinner />;
  const current = list.find((w) => w.id === open);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="muted max-w-xl">Os espaços de trabalho separam documentos por hotel ou departamento. Os administradores de um espaço veem todos os documentos desse espaço.</p>
        <button className="btn-primary" onClick={() => setCreating(true)}><PlusIcon className="h-4 w-4" /> Novo espaço</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((w) => (
          <button key={w.id} className="card p-4 text-left hover:border-navy-200" onClick={() => setOpen(w.id)}>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-50 font-semibold text-navy-700">{w.name[0]?.toUpperCase()}</div>
            <p className="mt-3 font-medium">{w.name}</p>
            <p className="text-xs text-slate-500">{w.workspace_members.length} membro(s) · criado {fmtDate(w.created_at)}</p>
          </button>
        ))}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Novo espaço de trabalho">
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const { data, error } = await supabase.from("workspaces").insert({ name: name.trim(), created_by: profile!.id }).select("id").single();
            if (error) return toast(errorMessage(error), "error");
            await supabase.from("workspace_members").insert({ workspace_id: data.id, user_id: profile!.id, role: "admin" });
            setName("");
            setCreating(false);
            load();
            refresh();
          }}
        >
          <input className="input" placeholder="Ex.: Altis Belém Hotel & Spa" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>Cancelar</button>
            <button className="btn-primary">Criar</button>
          </div>
        </form>
      </Modal>

      <Modal open={!!current} onClose={() => setOpen(null)} title={current?.name ?? ""} wide>
        {current && (
          <div className="space-y-6">
            <Members ws={current} users={users} onChange={() => { load(); refresh(); }} />
            <BrandSettings ws={current} onChange={load} />
          </div>
        )}
      </Modal>
    </div>
  );
}

function Members({ ws, users, onChange }: { ws: Ws; users: Profile[]; onChange: () => void }) {
  const [add, setAdd] = useState("");
  const [name, setName] = useState(ws.name);
  const members = ws.workspace_members
    .map((m) => ({ ...m, user: users.find((u) => u.id === m.user_id) }))
    .sort((a, b) => (a.user?.full_name ?? "").localeCompare(b.user?.full_name ?? ""));
  const others = users.filter((u) => u.active && !ws.workspace_members.some((m) => m.user_id === u.id));

  async function run(p: PromiseLike<{ error: unknown }>) {
    const { error } = await p;
    if (error) toast(errorMessage(error), "error");
    else onChange();
  }

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Nome do espaço" />
        <button className="btn-secondary" disabled={!name.trim() || name === ws.name} onClick={() => run(supabase.from("workspaces").update({ name: name.trim() }).eq("id", ws.id))}>Renomear</button>
      </div>
      <div>
        <p className="label">Membros</p>
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {members.map((m) => (
            <li key={m.user_id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.user?.full_name ?? m.user_id}</p>
                <p className="truncate text-xs text-slate-500">{m.user?.email}</p>
              </div>
              <select className="rounded border border-slate-200 px-2 py-1 text-sm" value={m.role} onChange={(e) => run(supabase.from("workspace_members").update({ role: e.target.value }).eq("workspace_id", ws.id).eq("user_id", m.user_id))} aria-label="Função">
                <option value="member">Membro</option>
                <option value="admin">Administrador do espaço</option>
              </select>
              <button className="rounded p-1 text-slate-400 hover:text-red-600" aria-label="Remover" onClick={() => run(supabase.from("workspace_members").delete().eq("workspace_id", ws.id).eq("user_id", m.user_id))}>
                <TrashIcon className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      </div>
      {others.length > 0 && (
        <div className="flex gap-2">
          <select className="input" value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Adicionar membro">
            <option value="">Adicionar colaborador…</option>
            {others.map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>)}
          </select>
          <button className="btn-primary" disabled={!add} onClick={() => { run(supabase.from("workspace_members").insert({ workspace_id: ws.id, user_id: add, role: "member" })); setAdd(""); }}>Adicionar</button>
        </div>
      )}
      <p className="text-xs text-slate-500">Os colaboradores aparecem aqui depois de entrarem no Signed pela primeira vez com a conta Microsoft.</p>
    </div>
  );
}

function Users() {
  const { profile } = useAuth();
  const [users, setUsers] = useState<Profile[] | null>(null);
  async function load() {
    const { data } = await supabase.from("profiles").select("id, email, full_name, role, active").order("full_name");
    setUsers(data ?? []);
  }
  useEffect(() => {
    load();
  }, []);
  if (!users) return <FullPageSpinner />;
  async function patch(id: string, p: Partial<Profile>) {
    const { error } = await supabase.from("profiles").update(p).eq("id", id);
    if (error) toast(errorMessage(error), "error");
    load();
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2.5 font-medium">Colaborador</th>
            <th className="px-4 py-2.5 font-medium">Função</th>
            <th className="px-4 py-2.5 font-medium">Estado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {users.map((u) => (
            <tr key={u.id}>
              <td className="px-4 py-2.5">
                <p className="font-medium">{u.full_name}</p>
                <p className="text-xs text-slate-500">{u.email}</p>
              </td>
              <td className="px-4 py-2.5">
                <select className="rounded border border-slate-200 px-2 py-1" value={u.role} disabled={u.id === profile?.id} onChange={(e) => patch(u.id, { role: e.target.value as Profile["role"] })} aria-label="Função">
                  <option value="user">Utilizador</option>
                  <option value="admin">Administrador</option>
                </select>
              </td>
              <td className="px-4 py-2.5">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={u.active} disabled={u.id === profile?.id} onChange={(e) => patch(u.id, { active: e.target.checked })} />
                  {u.active ? "Ativo" : "Desativado"}
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Settings() {
  const [s, setS] = useState<{ org_name: string; allowed_domains: string[]; admin_emails: string[] } | null>(null);
  const [domains, setDomains] = useState("");
  const [admins, setAdmins] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    supabase.from("app_settings").select("org_name, allowed_domains, admin_emails").single().then(({ data }) => {
      if (!data) return;
      setS(data);
      setDomains(data.allowed_domains.join("\n"));
      setAdmins(data.admin_emails.join("\n"));
    });
  }, []);
  if (!s) return <FullPageSpinner />;
  const split = (v: string) => v.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  return (
    <form
      className="card max-w-xl space-y-5 p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        const d = split(domains);
        if (!d.length) return toast("Indique pelo menos um domínio.", "error");
        const { error } = await supabase.from("app_settings").update({ org_name: s.org_name, allowed_domains: d, admin_emails: split(admins), updated_at: new Date().toISOString() }).eq("id", 1);
        if (error) toast(errorMessage(error), "error");
        else setSaved(true);
      }}
    >
      <div>
        <label className="label" htmlFor="org">Nome da organização</label>
        <input id="org" className="input" value={s.org_name} onChange={(e) => setS({ ...s, org_name: e.target.value })} required />
      </div>
      <div>
        <label className="label" htmlFor="dom">Domínios de email autorizados</label>
        <textarea id="dom" className="input min-h-20" value={domains} onChange={(e) => setDomains(e.target.value)} />
        <p className="mt-1 text-xs text-slate-500">Só contas Microsoft destes domínios conseguem entrar. Um por linha.</p>
      </div>
      <div>
        <label className="label" htmlFor="adm">Administradores automáticos</label>
        <textarea id="adm" className="input min-h-20" value={admins} onChange={(e) => setAdmins(e.target.value)} placeholder="nome@altishotels.com" />
        <p className="mt-1 text-xs text-slate-500">Estes emails ficam administradores no primeiro login.</p>
      </div>
      {saved && <Alert kind="success">Definições guardadas.</Alert>}
      <button className="btn-primary">Guardar</button>
    </form>
  );
}

/** Marca do hotel: cor e logótipo usados na página de assinatura, no formulário público e nos emails. */
function BrandSettings({ ws, onChange }: { ws: Ws; onChange: () => void }) {
  const [color, setColor] = useState(ws.brand_color ?? "#0f2445");
  const [busy, setBusy] = useState(false);
  const logoUrl = ws.logo_path ? supabase.storage.from("branding").getPublicUrl(ws.logo_path).data.publicUrl : null;
  const tooLight = luminance(color) > 0.45;

  async function save(patch: Partial<Pick<Ws, "brand_color" | "logo_path">>) {
    setBusy(true);
    const { error } = await supabase.from("workspaces").update(patch).eq("id", ws.id);
    setBusy(false);
    if (error) toast(errorMessage(error), "error");
    else {
      toast("Marca atualizada.");
      onChange();
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return toast("Use PNG, JPG ou WebP.", "error");
    if (file.size > 1024 * 1024) return toast("O logótipo tem de ter menos de 1 MB.", "error");
    setBusy(true);
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = `${ws.id}/logo-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from("branding").upload(path, file, { contentType: file.type });
    setBusy(false);
    if (error) return toast(errorMessage(error), "error");
    if (ws.logo_path) await supabase.storage.from("branding").remove([ws.logo_path]);
    await save({ logo_path: path });
  }

  return (
    <div className="border-t border-slate-200 pt-5">
      <p className="label">Marca do hotel</p>
      <p className="mb-3 text-xs text-slate-500">Aparece na página de assinatura, nos links públicos e nos emails aos signatários dos documentos deste espaço.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3">
          <div>
            <label className="label text-xs" htmlFor="b-color">Cor principal (botões)</label>
            <div className="flex items-center gap-2">
              <input id="b-color" type="color" className="h-9 w-12 cursor-pointer rounded border border-slate-200" value={color} onChange={(e) => setColor(e.target.value)} />
              <input className="input w-28 font-mono" value={color} maxLength={7} onChange={(e) => setColor(e.target.value)} aria-label="Cor em hexadecimal" />
              <button className="btn-secondary" disabled={busy || !/^#[0-9a-fA-F]{6}$/.test(color) || color === ws.brand_color} onClick={() => save({ brand_color: color.toLowerCase() })}>Guardar</button>
            </div>
            {tooLight && <p className="mt-1 text-xs text-amber-700">Cor demasiado clara: o texto branco dos botões fica difícil de ler.</p>}
          </div>
          <div>
            <label className="label text-xs">Logótipo (PNG, JPG ou WebP, até 1 MB)</label>
            <div className="flex flex-wrap items-center gap-2">
              <label className="btn-secondary cursor-pointer">
                {busy ? <Spinner className="h-4 w-4" /> : null} Carregar logótipo
                <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => upload(e.target.files?.[0])} disabled={busy} />
              </label>
              {ws.logo_path && <button className="btn-ghost text-red-700" disabled={busy} onClick={async () => { await supabase.storage.from("branding").remove([ws.logo_path!]); await save({ logo_path: null }); }}>Remover</button>}
            </div>
          </div>
          {(ws.brand_color || ws.logo_path) && (
            <button className="text-xs text-slate-500 underline" disabled={busy} onClick={() => save({ brand_color: null })}>Repor a cor do Signed</button>
          )}
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-xs text-slate-500">Pré-visualização</p>
          <div className="rounded-md bg-white p-3 shadow-sm" style={{ borderTop: `3px solid ${color}` }}>
            <BrandMark brand={{ name: ws.name, color, logoUrl }} />
            <button className="btn mt-3 w-full text-white" style={{ background: color }}>Assinar documento</button>
          </div>
        </div>
      </div>
    </div>
  );
}
