// Página pública de um link/QR: a pessoa indica o nome e o email e passa à assinatura.
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { publicForm, rememberSignerSession } from "../lib/api";
import { Alert, FullPageSpinner, IdIcon, Logo, Spinner } from "../components/ui";
import { errorMessage } from "../lib/format";

interface Info {
  title: string;
  require_email_code: boolean;
  mode: "simple" | "qualified";
  message: string | null;
  organization: string | null;
}

export function PublicForm() {
  const { slug = "" } = useParams();
  const nav = useNavigate();
  const [info, setInfo] = useState<Info | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    publicForm<Info>({ action: "info", slug }).then(setInfo).catch((e) => setFatal(errorMessage(e)));
  }, [slug]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await publicForm<{ token: string; session?: string }>({ action: "start", slug, name, email });
      if (r.session) rememberSignerSession(r.token, r.session);
      nav(`/s/${r.token}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-xl items-center justify-between px-4 py-3">
          <Logo />
          {info?.organization && <span className="text-sm text-slate-500">{info.organization}</span>}
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 py-8">
        {fatal ? (
          <Alert>{fatal}</Alert>
        ) : !info ? (
          <FullPageSpinner />
        ) : (
          <form onSubmit={start} className="card p-6">
            <h1 className="text-xl font-semibold tracking-tight">{info.title}</h1>
            {info.message && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{info.message}</p>}
            {info.mode === "qualified" && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-navy-50 p-3 text-sm text-navy-800">
                <IdIcon className="mt-0.5 h-4 w-4 shrink-0" /> Este documento é assinado com Cartão de Cidadão ou Chave Móvel Digital.
              </p>
            )}
            <div className="mt-5 space-y-3">
              <div>
                <label className="label" htmlFor="pf-name">Nome completo</label>
                <input id="pf-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="name" required />
              </div>
              <div>
                <label className="label" htmlFor="pf-email">Email</label>
                <input id="pf-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
                <p className="mt-1 text-xs text-slate-500">
                  {info.require_email_code ? "Vamos enviar um código para confirmar o email. " : ""}Recebe neste email a cópia assinada.
                </p>
              </div>
              <label className="flex items-start gap-2 text-xs text-slate-600">
                <input type="checkbox" className="mt-0.5" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                Aceito que o meu nome, email, a data, a hora e o endereço IP fiquem registados como prova da assinatura.
              </label>
            </div>
            {error && <div className="mt-4"><Alert>{error}</Alert></div>}
            <button className="btn-primary mt-5 w-full py-2.5" disabled={busy || !agree || !name.trim() || !email.trim()}>
              {busy && <Spinner className="h-4 w-4 text-white" />} Continuar
            </button>
          </form>
        )}
        <p className="mt-4 text-center text-xs text-slate-500">Signed · plataforma de assinatura eletrónica do Grupo Altis Hotels</p>
      </main>
    </div>
  );
}
