import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { Alert, Logo, ShieldIcon, IdIcon, PenIcon } from "../components/ui";

const DEV = import.meta.env.VITE_DEV_LOGIN === "true";

export function Login() {
  const { error: authError, session, signOut } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Modo de teste (definido na base de dados): login com email e palavra-passe antes do Microsoft 365.
  const [testMode, setTestMode] = useState(false);
  useEffect(() => {
    supabase.rpc("login_options").then(({ data }) => setTestMode(!!(data as { test_mode?: boolean } | null)?.test_mode));
  }, []);

  async function microsoft() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "azure",
      options: { scopes: "openid email profile", redirectTo: window.location.origin },
    });
    if (error) {
      setError("Não foi possível iniciar sessão com a Microsoft. O login Microsoft já está configurado no Supabase?");
      setBusy(false);
    }
  }

  async function dev(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message === "Invalid login credentials" ? "Email ou palavra-passe incorretos." : error.message);
    setBusy(false);
  }

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-navy-900 p-12 text-white lg:flex">
        <Logo light />
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">Contratos assinados sem papel, com valor legal.</h1>
          <ul className="mt-8 space-y-4 text-navy-100">
            <li className="flex gap-3">
              <PenIcon className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" />
              <span>Envie documentos para assinar a fornecedores, colaboradores e clientes, com ordem de assinatura e lembretes.</span>
            </li>
            <li className="flex gap-3">
              <IdIcon className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" />
              <span>Assinatura qualificada com Cartão de Cidadão ou Chave Móvel Digital.</span>
            </li>
            <li className="flex gap-3">
              <ShieldIcon className="mt-0.5 h-5 w-5 shrink-0 text-sky-300" />
              <span>Registo de auditoria inalterável e certificado de conclusão em cada documento.</span>
            </li>
          </ul>
        </div>
        <p className="text-xs text-navy-200">Grupo Altis Hotels · uso interno</p>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Logo />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">Entrar</h2>
          <p className="muted mt-1">Use a sua conta Microsoft da Altis.</p>

          {(error || (session && authError)) && (
            <div className="mt-5">
              <Alert>{error ?? authError}</Alert>
              {session && authError && (
                <button className="btn-ghost mt-2" onClick={signOut}>
                  Entrar com outra conta
                </button>
              )}
            </div>
          )}

          <button className="btn-secondary mt-6 w-full py-2.5" onClick={microsoft} disabled={busy}>
            <svg viewBox="0 0 21 21" className="h-4 w-4" aria-hidden>
              <rect x="1" y="1" width="9" height="9" fill="#f25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
              <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
              <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
            </svg>
            Entrar com Microsoft
          </button>

          {(DEV || testMode) && (
            <form onSubmit={dev} className="mt-8 space-y-3 border-t border-slate-200 pt-6">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{DEV ? "Desenvolvimento" : "Modo de teste"}</p>
              <input className="input" type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <input className="input" type="password" placeholder="palavra-passe" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button className="btn-primary w-full" disabled={busy}>
                Entrar
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
