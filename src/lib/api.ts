// Chamadas às edge functions.
import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase";

export class ApiError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(fn: string, body: unknown, auth: boolean): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY };
  if (auth) {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new ApiError("Sessão expirada. Volte a entrar.", 401);
    headers.Authorization = `Bearer ${data.session.access_token}`;
  } else {
    headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  }
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    throw new ApiError("Sem ligação ao servidor. Verifique a internet e tente de novo.", 0);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? `Erro ${res.status}`, res.status, json.code);
  return json as T;
}

export const documentAction = (action: "send" | "cancel" | "remind", document_id: string, recipient_id?: string) =>
  call<{ ok: boolean }>("document-actions", { action, document_id, recipient_id }, true);

/** Corrige destinatários ainda por assinar e/ou o prazo de um documento em curso. */
export const correctDocument = (
  document_id: string,
  patch: { recipients?: { id: string; name: string; email: string; civil_id?: string | null }[]; expires_at?: string | null },
) => call<{ ok: boolean; changed: number }>("document-actions", { action: "correct", document_id, ...patch }, true);

export const convertDocx = (document_id: string) => call<{ ok: boolean; path: string; pages: number }>("convert-docx", { document_id }, true);

export const signerApi = <T,>(body: Record<string, unknown>) => call<T>("signer-api", body, false);
