import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: "admin" | "user";
  active: boolean;
  weekly_digest?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  myRole: "admin" | "member";
}

interface AuthState {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  workspaces: Workspace[];
  error: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Utilizador cujo perfil já está carregado (o Supabase volta a emitir SIGNED_IN ao regressar ao separador).
  const loadedFor = useRef<string | null>(null);

  async function load(s: Session | null) {
    setSession(s);
    if (!s) {
      loadedFor.current = null;
      setProfile(null);
      setWorkspaces([]);
      setLoading(false);
      return;
    }
    if (loadedFor.current === s.user.id) return;
    const { data: p, error: pe } = await supabase.from("profiles").select("id, email, full_name, role, active, weekly_digest").eq("id", s.user.id).maybeSingle();
    if (pe) {
      // Falha de rede: não deita fora a sessão nem o trabalho em curso.
      if (!loadedFor.current) setError("Não foi possível ligar ao Signed. Verifique a ligação à internet e recarregue a página.");
      setLoading(false);
      return;
    }
    if (!p) {
      setError("A sua conta não tem acesso ao Signed. Fale com o administrador.");
      setProfile(null);
    } else if (!p.active) {
      setError("A sua conta está desativada.");
      setProfile(null);
    } else {
      setError(null);
      setProfile(p);
      loadedFor.current = p.id;
      const { data: ws } = await supabase.from("workspaces").select("id, name, workspace_members(role, user_id)").order("name");
      setWorkspaces(
        (ws ?? []).map((w) => {
          const mine = (w.workspace_members as { role: "admin" | "member"; user_id: string }[]).find((m) => m.user_id === p.id);
          return { id: w.id, name: w.name, myRole: mine?.role ?? (p.role === "admin" ? "admin" : "member") };
        }),
      );
    }
    setLoading(false);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => load(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "USER_UPDATED") loadedFor.current = null;
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") load(s);
      else setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <Ctx.Provider
      value={{
        loading,
        session,
        profile,
        workspaces,
        error,
        refresh: async () => {
          loadedFor.current = null;
          await load((await supabase.auth.getSession()).data.session);
        },
        signOut: async () => {
          await supabase.auth.signOut();
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth fora do AuthProvider");
  return v;
}
