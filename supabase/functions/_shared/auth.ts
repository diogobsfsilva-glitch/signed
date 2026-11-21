import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./http.ts";

export interface AuthedUser {
  id: string;
  email: string;
  role: "admin" | "user";
  full_name: string | null;
}

/** Valida o JWT do colaborador e devolve o perfil ativo. */
export async function requireUser(sb: SupabaseClient, req: Request): Promise<AuthedUser> {
  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) throw new HttpError(401, "Sessão inválida. Volte a entrar.", "unauthorized");
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data.user) throw new HttpError(401, "Sessão inválida. Volte a entrar.", "unauthorized");
  const { data: profile } = await sb.from("profiles").select("id, email, role, full_name, active").eq("id", data.user.id).single();
  if (!profile || !profile.active) throw new HttpError(403, "Conta inativa.", "inactive");
  return profile;
}

/** Dono do documento ou administrador (global ou do espaço de trabalho). */
export async function canManage(sb: SupabaseClient, user: AuthedUser, doc: { owner_id: string; workspace_id: string }): Promise<boolean> {
  if (doc.owner_id === user.id || user.role === "admin") return true;
  const { data } = await sb
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", doc.workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();
  return data?.role === "admin";
}
