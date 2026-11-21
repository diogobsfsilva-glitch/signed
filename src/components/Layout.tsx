import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { InboxIcon, Logo, LogoutIcon, MenuIcon, PlusIcon, SettingsIcon, TemplateIcon } from "./ui";

export function Layout() {
  const { profile, signOut } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [testMode, setTestMode] = useState(false);
  useEffect(() => {
    supabase.from("app_settings").select("test_mode").eq("id", 1).maybeSingle().then(({ data }) => setTestMode(!!data?.test_mode));
  }, []);

  const link = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium ${isActive ? "bg-white/10 text-white" : "text-navy-100 hover:bg-white/5 hover:text-white"}`;

  const sidebar = (
    <div className="flex h-full flex-col bg-navy-900 px-3 py-4">
      <div className="px-2 pb-6">
        <Logo light />
        <p className="mt-1 text-xs text-navy-200">Altis Hotels</p>
      </div>
      <button
        className="btn mb-4 w-full bg-sky-400 text-navy-900 hover:bg-sky-300"
        onClick={() => {
          setOpen(false);
          nav("/novo");
        }}
      >
        <PlusIcon className="h-4 w-4" /> Novo documento
      </button>
      <nav className="flex flex-col gap-1" onClick={() => setOpen(false)}>
        <NavLink to="/" end className={link}>
          <InboxIcon className="h-4.5 w-4.5" /> Documentos
        </NavLink>
        <NavLink to="/modelos" className={link}>
          <TemplateIcon className="h-4.5 w-4.5" /> Modelos
        </NavLink>
        {profile?.role === "admin" && (
          <NavLink to="/admin" className={link}>
            <SettingsIcon className="h-4.5 w-4.5" /> Administração
          </NavLink>
        )}
      </nav>
      <div className="mt-auto border-t border-white/10 pt-3">
        <div className="px-2 pb-2">
          <p className="truncate text-sm font-medium text-white">{profile?.full_name}</p>
          <p className="truncate text-xs text-navy-200">{profile?.email}</p>
        </div>
        <button className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-navy-100 hover:bg-white/5 hover:text-white" onClick={signOut}>
          <LogoutIcon className="h-4.5 w-4.5" /> Sair
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-slate-900/40" />
          <aside className="absolute inset-y-0 left-0 w-64" onClick={(e) => e.stopPropagation()}>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <button className="btn-ghost px-2" onClick={() => setOpen(true)} aria-label="Abrir menu">
            <MenuIcon />
          </button>
          <Logo />
        </header>
        {testMode && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900">
            <strong>Modo de teste:</strong> os emails não são enviados. Abra o documento enviado, separador <em>Emails</em>, e reencaminhe o link e o código ao signatário.
          </div>
        )}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
