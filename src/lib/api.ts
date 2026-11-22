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

/** Abre a assinatura de um destinatário presencial neste dispositivo. */
export const inPersonSession = (document_id: string, recipient_id: string) =>
  call<{ token: string; session: string }>("document-actions", { action: "in_person", document_id, recipient_id }, true);

/** Formulário público (link ou QR): sem sessão de colaborador. */
export const publicForm = <T,>(body: Record<string, unknown>) => call<T>("public-form", body, false);

/** Guarda a sessão do signatário para a página /s/:token a usar logo (presencial ou link público). */
export function rememberSignerSession(token: string, session: string) {
  try {
    sessionStorage.setItem(`signed:s:${token.slice(0, 16)}`, session);
  } catch {
    /* sem armazenamento: a página pede o código */
  }
}

export const convertDocx = (document_id: string) => call<{ ok: boolean; path: string; pages: number }>("convert-docx", { document_id }, true);

export const signerApi = <T,>(body: Record<string, unknown>) => call<T>("signer-api", body, false);
