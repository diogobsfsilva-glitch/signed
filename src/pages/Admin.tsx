import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth, type Profile } from "../auth/AuthProvider";
import { Alert, FullPageSpinner, Modal, PlusIcon, TrashIcon, toast } from "../components/ui";
import { errorMessage, fmtDate } from "../lib/format";

type Tab = "workspaces" | "users" | "settings";

interface Ws {
  id: string;
  name: string;
  created_at: string;
  workspace_members: { user_id: string; role: "admin" | "member" }[];
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
      supabase.from("workspaces").select("id, name, created_at, workspace_members(user_id, role)").order("name"),
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
        {current && <Members ws={current} users={users} onChange={() => { load(); refresh(); }} />}
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
