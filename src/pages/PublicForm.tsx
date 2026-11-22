// Página pública de um link/QR: a pessoa indica o nome e o email e passa à assinatura.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { publicForm, rememberSignerSession } from "../lib/api";
import { Alert, FullPageSpinner, IdIcon, Logo, Spinner } from "../components/ui";
import { BrandMark, brandStyle, type BrandInfo } from "../components/Brand";
import { browserLang, I18n, isLang, LANGS, translator, type Lang } from "../lib/signer-i18n";

interface Info {
  title: string;
  require_email_code: boolean;
  mode: "simple" | "qualified";
  message: string | null;
  organization: string | null;
  brand?: BrandInfo | null;
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
  const [lang, setLang] = useState<Lang>(() => {
    try {
      const v = localStorage.getItem("signed:lang");
      return isLang(v) ? v : browserLang();
    } catch {
      return browserLang();
    }
  });
  const tr = useMemo(() => translator(lang), [lang]);
  const { t } = tr;
  function pickLang(l: Lang) {
    setLang(l);
    try {
      localStorage.setItem("signed:lang", l);
    } catch {
      /* ignorar */
    }
  }

  useEffect(() => {
    publicForm<Info>({ action: "info", slug }).then(setInfo).catch((e) => setFatal(translator(lang).error(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await publicForm<{ token: string; session?: string }>({ action: "start", slug, name, email, language: lang });
      if (r.session) rememberSignerSession(r.token, r.session);
      nav(`/s/${r.token}`, { replace: true });
    } catch (err) {
      setError(tr.error(err));
      setBusy(false);
    }
  }

  return (
    <I18n.Provider value={tr}>
    <div className="min-h-full bg-slate-100" lang={lang} style={brandStyle(info?.brand)}>
      <header className="border-b border-slate-200 bg-white" style={info?.brand?.color ? { borderTop: `3px solid ${info.brand.color}` } : undefined}>
        <div className="mx-auto flex max-w-xl items-center justify-between px-4 py-3">
          {info ? <BrandMark brand={info.brand} /> : <Logo />}
          <div className="flex items-center gap-3">
            {info?.organization && !info.brand && <span className="hidden text-sm text-slate-500 sm:inline">{info.organization}</span>}
            <select className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-700" value={lang} onChange={(e) => pickLang(e.target.value as Lang)} aria-label="Language / Idioma">
              {LANGS.map((l) => <option key={l.code} value={l.code}>{l.code.toUpperCase()} · {l.label}</option>)}
            </select>
          </div>
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
                <IdIcon className="mt-0.5 h-4 w-4 shrink-0" /> {t("qualified_note")}
              </p>
            )}
            <div className="mt-5 space-y-3">
              <div>
                <label className="label" htmlFor="pf-name">{t("full_name")}</label>
                <input id="pf-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="name" required />
              </div>
              <div>
                <label className="label" htmlFor="pf-email">{t("email")}</label>
                <input id="pf-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
                <p className="mt-1 text-xs text-slate-500">
                  {info.require_email_code ? `${t("pf_code_note")} ` : ""}{t("pf_copy_note")}
                </p>
              </div>
              <label className="flex items-start gap-2 text-xs text-slate-600">
                <input type="checkbox" className="mt-0.5" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                {t("pf_consent")}
              </label>
            </div>
            {error && <div className="mt-4"><Alert>{error}</Alert></div>}
            <button className="btn-primary mt-5 w-full py-2.5" disabled={busy || !agree || !name.trim() || !email.trim()}>
              {busy && <Spinner className="h-4 w-4 text-white" />} {t("pf_continue")}
            </button>
          </form>
        )}
        <p className="mt-4 text-center text-xs text-slate-500">{t("footer")}</p>
      </main>
    </div>
    </I18n.Provider>
  );
}
