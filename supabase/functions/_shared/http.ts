// Utilitários HTTP para as edge functions.

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Envolve um handler: CORS, JSON e erros em português. */
export function handler(fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      const err = e as { message?: string; code?: string };
      if (err?.code && typeof err.code === "string" && err.constructor?.name === "VerifyError") {
        return json({ error: err.message, code: err.code }, 422);
      }
      console.error(e);
      return json({ error: "Ocorreu um erro inesperado. Tente novamente dentro de momentos." }, 500);
    }
  };
}

export function clientIp(req: Request): string | null {
  const h = req.headers;
  return (
    h.get("cf-connecting-ip") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

export function userAgent(req: Request): string | null {
  return req.headers.get("user-agent")?.slice(0, 400) ?? null;
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Pedido inválido");
  }
}

export function env(name: string, required = true): string {
  const v = Deno.env.get(name);
  if (!v && required) throw new Error(`Variável de ambiente em falta: ${name}`);
  return v ?? "";
}
