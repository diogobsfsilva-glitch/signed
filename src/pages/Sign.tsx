import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { createClient } from "@supabase/supabase-js";
import { ApiError, signerApi } from "../lib/api";
import { SUPABASE_ANON_KEY, SUPABASE_URL, BUCKET } from "../lib/supabase";
import type { FieldType } from "../../supabase/functions/_shared/types";
import { isAutoField } from "../../supabase/functions/_shared/types";
import { PdfPages } from "../components/PdfPages";
import { PartsIndex } from "../components/Parts";
import type { DocPart } from "../../supabase/functions/_shared/types";
import { BrandMark, brandStyle, type BrandInfo } from "../components/Brand";
import { SignaturePad } from "../components/SignaturePad";
import { FieldValue } from "../components/FieldBox";
import { Alert, CheckIcon, DownloadIcon, FullPageSpinner, IdIcon, Logo, Modal, Spinner, UploadIcon } from "../components/ui";
import { browserLang, I18n, isLang, LANGS, translator, useT, type Lang } from "../lib/signer-i18n";

// Cliente sem sessão (o signatário não tem conta).
const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: "signed-signer" } });

interface StartInfo {
  recipient: { name: string; email: string; status: string; in_person?: boolean; language?: string; group?: string[] | null };
  document: { title: string; status: string; sender: string; mode: "simple" | "qualified" };
  brand?: BrandInfo | null;
}
interface SField {
  id: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
  label: string | null;
  options: string[] | null;
  value: string | null;
  readonly?: boolean;
  editable: boolean;
}
interface LoadInfo {
  document: { id: string; title: string; status: string; mode: "simple" | "qualified"; phase: "fill" | "sign"; message: string | null; sender: string; expires_at: string | null; parts?: DocPart[] | null };
  recipient: { id: string; name: string; status: string; color: string };
  step: "fill" | "sign_simple" | "sign_cc" | "wait" | "done";
  yourTurn: boolean;
  pdfUrl: string;
  overlay: boolean;
  fields: SField[];
  others: Omit<SField, "required" | "label" | "editable">[];
}

export function Sign() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  // Assinatura presencial: o colaborador abriu esta página no seu dispositivo (id do documento).
  const hostDoc = params.get("presencial");
  const key = `signed:s:${token.slice(0, 16)}`;
  const [start, setStart] = useState<StartInfo | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  });
  const [info, setInfo] = useState<LoadInfo | null>(null);
  const [finished, setFinished] = useState<null | "signed" | "filled" | "declined" | "delegated">(null);
  // Idioma: o escolhido pela pessoa nesta página, senão o definido pelo remetente, senão o do navegador.
  // Guardado só para este link e este separador: num tablet partilhado, o hóspede seguinte não o herda.
  const langKey = `signed:lang:${token}`;
  const [chosen, setChosen] = useState<Lang | null>(() => {
    try {
      const v = sessionStorage.getItem(langKey);
      return isLang(v) ? v : null;
    } catch {
      return null;
    }
  });
  const lang: Lang = chosen ?? (isLang(start?.recipient.language) ? start!.recipient.language as Lang : browserLang());
  const tr = useMemo(() => translator(lang), [lang]);
  function pickLang(l: Lang) {
    setChosen(l);
    try {
      sessionStorage.setItem(langKey, l);
    } catch {
      /* ignorar */
    }
  }

  useEffect(() => {
    signerApi<StartInfo>({ action: "start", token })
      .then(setStart)
      .catch((e) => setFatal(translator(chosen ?? browserLang()).error(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function load(s = session) {
    if (!s) return;
    try {
      setInfo(await signerApi<LoadInfo>({ action: "load", token, session: s }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "session_required") {
        setSession(null);
        try {
          sessionStorage.removeItem(key);
        } catch {
          /* ignorar */
        }
      } else setFatal(tr.error(e));
    }
  }

  useEffect(() => {
    if (session && start) load(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, start]);

  return (
    <I18n.Provider value={tr}>
    <div className="min-h-full bg-slate-100" lang={lang} style={brandStyle(start?.brand)}>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur" style={start?.brand?.color ? { borderTop: `3px solid ${start.brand.color}` } : undefined}>
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          {start ? <BrandMark brand={start.brand} /> : <Logo />}
          <div className="flex min-w-0 items-center gap-3">
            {start && <p className="hidden min-w-0 truncate text-sm text-slate-600 sm:block">{start.document.title}</p>}
            <LangPicker lang={lang} onChange={pickLang} />
          </div>
        </div>
      </header>
      {hostDoc && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900">
          {tr.t("in_person_banner")}
        </div>
      )}
      <main className="mx-auto max-w-5xl px-4 py-6">
        {fatal ? (
          <Centered>
            <Alert>{fatal}</Alert>
          </Centered>
        ) : !start ? (
          <FullPageSpinner />
        ) : finished ? (
          <Done kind={finished} title={start.document.title} hostDoc={hostDoc} />
        ) : start.document.status !== "in_progress" ? (
          <Centered>
            <Alert kind="info">
              {tr.t(({ completed: "st_completed", declined: "st_declined", cancelled: "st_cancelled", expired: "st_expired" } as const)[start.document.status as "completed"] ?? "st_unavailable")}
            </Alert>
          </Centered>
        ) : !session && start.recipient.in_person ? (
          <Centered>
            <Alert kind="info">{tr.t("in_person_need_host")}</Alert>
          </Centered>
        ) : !session ? (
          <Otp token={token} start={start} onSession={(s) => {
            try {
              sessionStorage.setItem(key, s);
            } catch {
              /* ignorar */
            }
            setSession(s);
          }} />
        ) : !info ? (
          <FullPageSpinner label={tr.t("opening")} />
        ) : (
          <Flow token={token} session={session} info={info} reload={() => load()} onFinished={setFinished} inPerson={!!start.recipient.in_person || !!hostDoc} />
        )}
      </main>
    </div>
    </I18n.Provider>
  );
}

function LangPicker({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  return (
    <select className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-700" value={lang} onChange={(e) => onChange(e.target.value as Lang)} aria-label="Language / Idioma">
      {LANGS.map((l) => <option key={l.code} value={l.code}>{l.code.toUpperCase()} · {l.label}</option>)}
    </select>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto mt-10 max-w-md">{children}</div>;
}

function Otp({ token, start, onSession }: { token: string; start: StartInfo; onSession: (s: string) => void }) {
  const { t, tn, error: errText } = useT();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [member, setMember] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await signerApi({ action: "send-otp", token, member: member ?? undefined });
      setSent(true);
    } catch (e) {
      setError(errText(e));
      if (e instanceof ApiError && e.code === "rate_limited") setSent(true);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await signerApi<{ session: string }>({ action: "verify-otp", token, code });
      onSession(r.session);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-6 max-w-md">
      <div className="card p-6">
        <p className="text-sm text-slate-500">{t("sent_you", { sender: start.document.sender })}</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{start.document.title}</h1>
        {start.document.mode === "qualified" && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-navy-50 p-3 text-sm text-navy-800">
            <IdIcon className="mt-0.5 h-4 w-4 shrink-0" />
            {t("qualified_note")}
          </p>
        )}
        <div className="mt-5 border-t border-slate-100 pt-5">
          <p className="text-sm">
            {start.recipient.group ? (
              tn("group_intro", { name: <strong>{start.recipient.name}</strong> })
            ) : (
              <>{tn("hello", { name: <strong>{start.recipient.name}</strong> })} {tn("code_intro", { email: <strong>{start.recipient.email}</strong> })}</>
            )}
          </p>
          {start.recipient.group && !sent && (
            <div className="mt-3 space-y-1.5" role="radiogroup">
              {start.recipient.group.map((m, i) => (
                <label key={m} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${member === i ? "border-navy-500 bg-navy-50" : "border-slate-200"}`}>
                  <input type="radio" name="member" checked={member === i} onChange={() => setMember(i)} /> {m}
                </label>
              ))}
            </div>
          )}
          {!sent ? (
            <button className="btn-primary mt-4 w-full py-2.5" onClick={send} disabled={busy || (!!start.recipient.group && member === null)}>
              {busy && <Spinner className="h-4 w-4 text-white" />} {t("send_code")}
            </button>
          ) : (
            <form onSubmit={verify} className="mt-4 space-y-3">
              <label className="label" htmlFor="code">{t("code_label")}</label>
              <input
                id="code"
                className="input text-center text-2xl tracking-[0.5em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                autoFocus
              />
              <button className="btn-primary w-full py-2.5" disabled={busy || code.length !== 6}>
                {busy && <Spinner className="h-4 w-4 text-white" />} {t("open_doc")}
              </button>
              <button type="button" className="btn-ghost w-full" onClick={send} disabled={busy}>{t("resend_code")}</button>
            </form>
          )}
          {error && <div className="mt-3"><Alert>{error}</Alert></div>}
        </div>
      </div>
      <p className="mt-4 text-center text-xs text-slate-500">{t("footer")}</p>
    </div>
  );
}

function Flow({ token, session, info, reload, onFinished, inPerson }: { token: string; session: string; info: LoadInfo; reload: () => void; onFinished: (k: "signed" | "filled" | "declined" | "delegated") => void; inPerson: boolean }) {
  const [declining, setDeclining] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const { t } = useT();
  const canDelegate = !inPerson && ["pending", "notified", "viewed"].includes(info.recipient.status) && info.document.status === "in_progress";

  const header = (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-sm text-slate-500">{t("from_sender", { sender: info.document.sender })}</p>
        <h1 className="text-xl font-semibold tracking-tight">{info.document.title}</h1>
      </div>
      <div className="flex gap-1">
        {canDelegate && (
          <button className="btn-ghost" onClick={() => setDelegating(true)} title={t("delegate_hint")}>{t("delegate")}</button>
        )}
        {info.step !== "done" && info.step !== "wait" && (
          <button className="btn-ghost text-red-700" onClick={() => setDeclining(true)}>{t("decline")}</button>
        )}
      </div>
      <PartsIndex parts={info.document.parts} className="w-full" />
    </div>
  );

  const message = info.document.message && (
    <div className="mb-5 rounded-lg border-l-4 border-navy-200 bg-white px-4 py-3 text-sm whitespace-pre-wrap text-slate-700 shadow-sm">{info.document.message}</div>
  );

  return (
    <>
      {header}
      {message}
      {info.step === "wait" && (
        <div className="mb-5">
          <Alert kind="info">
            {info.recipient.status === "filled" ? t("wait_filled") : t("wait_turn")}
          </Alert>
        </div>
      )}
      {info.step === "done" && (
        <div className="mb-5"><Alert kind="success">{t("already_signed")}</Alert></div>
      )}
      {info.step === "sign_cc" ? (
        <CcWizard token={token} session={session} info={info} onDone={(completed) => (completed ? onFinished("signed") : reload())} onFinished={onFinished} />
      ) : (
        <FillAndSign token={token} session={session} info={info} onFinished={onFinished} />
      )}
      <DeclineModal open={declining} onClose={() => setDeclining(false)} token={token} session={session} onDone={() => onFinished("declined")} />
      <DelegateModal open={delegating} onClose={() => setDelegating(false)} token={token} session={session} mode={info.document.mode} onDone={() => onFinished("delegated")} />
    </>
  );
}

function FillAndSign({ token, session, info, onFinished }: { token: string; session: string; info: LoadInfo; onFinished: (k: "signed" | "filled") => void }) {
  const interactive = info.step === "sign_simple" || info.step === "fill";
  const [values, setValues] = useState<Record<string, string>>(() => {
    // As datas começam vazias: preencher "hoje" fazia uma data de nascimento obrigatória passar sem ser preenchida.
    const v: Record<string, string> = {};
    for (const f of info.fields) if (f.value) v[f.id] = f.value;
    return v;
  });
  // Anexos carregados nesta sessão: id do campo -> nome do ficheiro (para mostrar).
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [pad, setPad] = useState<SField | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attention, setAttention] = useState<string | null>(null);
  const savedSig = useRef<Record<string, string>>({});
  const { t, tn, error: errText } = useT();

  const editable = info.fields.filter((f) => f.editable);
  const isFilled = (f: SField) => (f.type === "checkbox" ? values[f.id] === "true" : !!values[f.id]);
  const missing = editable.filter((f) => f.required && !isFilled(f));
  const ordered = useMemo(() => [...editable].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x), [editable]);
  const small = useIsSmall();
  // Campo aberto no painel de baixo (preenchimento guiado, sobretudo no telemóvel).
  const [active, setActive] = useState<string | null>(null);
  const activeField = ordered.find((f) => f.id === active) ?? null;
  const [zoom, setZoom] = useState(1);

  function goTo(f: SField) {
    setActive(f.id);
    setTimeout(() => {
      document.querySelector(`[data-field="${f.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    }, 50);
    setAttention(f.id);
    setTimeout(() => setAttention(null), 1600);
  }

  function goNext() {
    const next = ordered.find((f) => f.required && !isFilled(f)) ?? ordered[0];
    if (!next) return;
    goTo(next);
    if ((next.type === "signature" || next.type === "initials") && !values[next.id]) setPad(next);
  }

  function step(dir: 1 | -1) {
    const i = ordered.findIndex((f) => f.id === active);
    const target = ordered[i + dir];
    if (target) return goTo(target);
    if (dir === 1) {
      const left = ordered.find((f) => f.required && !isFilled(f));
      if (left) return goTo(left);
      setActive(null);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, string | null> = {};
      for (const f of editable) payload[f.id] = values[f.id] ?? (f.type === "checkbox" ? "false" : null);
      await signerApi({ action: "submit", token, session, values: payload });
      onFinished(info.step === "fill" ? "filled" : "signed");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const color = info.recipient.color;
  const setValue = (fid: string, v: string) => setValues((x) => ({ ...x, [fid]: v }));
  const onFile = (fid: string) => (path: string, name: string) => {
    setValues((x) => ({ ...x, [fid]: path }));
    setFileNames((x) => ({ ...x, [fid]: name }));
  };

  return (
    <div className={activeField ? "pb-80" : "pb-40"}>
      {small && (
        <div className="mb-2 flex items-center justify-end gap-1">
          <button className="btn-secondary h-9 w-9 justify-center p-0 text-lg" onClick={() => setZoom((z) => Math.max(1, z - 0.5))} disabled={zoom <= 1} aria-label={t("zoom_out")}>−</button>
          <span className="w-14 text-center text-sm tabular-nums text-slate-600">{Math.round(zoom * 100)}%</span>
          <button className="btn-secondary h-9 w-9 justify-center p-0 text-lg" onClick={() => setZoom((z) => Math.min(3, z + 0.5))} disabled={zoom >= 3} aria-label={t("zoom_in")}>+</button>
        </div>
      )}

      <div className="mx-auto max-w-[860px] overflow-x-auto">
        <div style={{ width: `${zoom * 100}%` }}>
        <PdfPages
          src={info.pdfUrl}
          parts={info.document.parts}
          overlay={(page, size) => (
            <>
              {info.others.filter((f) => f.page === page).map((f) => (
                <div key={f.id} className="absolute flex items-center overflow-hidden text-navy-900" style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}>
                  <FieldValue type={f.type} value={f.value} options={f.options} height={f.h * size.height} />
                </div>
              ))}
              {info.fields.filter((f) => f.page === page).map((f) => (
                <SignerField
                  key={f.id}
                  f={f}
                  color={color}
                  value={values[f.id] ?? null}
                  interactive={interactive && f.editable}
                  attention={attention === f.id || active === f.id}
                  heightPx={f.h * size.height}
                  recipientName={info.recipient.name}
                  fileName={fileNames[f.id]}
                  token={token}
                  session={session}
                  compact={small}
                  onOpen={() => goTo(f)}
                  onChange={(v) => setValue(f.id, v)}
                  onFile={onFile(f.id)}
                  onSign={() => {
                    if (small) goTo(f);
                    setPad(f);
                  }}
                />
              ))}
            </>
          )}
        />
        </div>
      </div>

      {interactive && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 shadow-[0_-4px_16px_rgba(15,36,69,0.08)] backdrop-blur">
          {activeField ? (
            <FieldSheet
              f={activeField}
              index={ordered.indexOf(activeField) + 1}
              total={ordered.length}
              value={values[activeField.id] ?? null}
              fileName={fileNames[activeField.id]}
              token={token}
              session={session}
              onChange={(v) => setValue(activeField.id, v)}
              onFile={onFile(activeField.id)}
              onSign={() => setPad(activeField)}
              onPrev={() => step(-1)}
              onNext={() => step(1)}
              onClose={() => setActive(null)}
            />
          ) : (
            <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
              {missing.length > 0 ? (
                <>
                  <p className="flex-1 text-sm text-slate-700">
                    {missing.length === 1 ? t("missing_one") : tn("missing", { n: <strong>{missing.length}</strong> })}
                    {info.step === "fill" && <span className="block text-xs text-slate-500">{t("fill_phase_note")}</span>}
                  </p>
                  <button className="btn-primary px-6 py-2.5" onClick={goNext}>{Object.keys(values).length ? t("fill_missing") : t("start")}</button>
                </>
              ) : (
                <>
                  {info.step === "sign_simple" ? (
                    <label className="flex flex-1 items-start gap-2 text-xs text-slate-600">
                      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                      {t("consent_sign")}
                    </label>
                  ) : (
                    <p className="flex-1 text-xs text-slate-600">{t("consent_fill")}</p>
                  )}
                  {error && <div className="sm:max-w-sm"><Alert>{error}</Alert></div>}
                  <button
                    className="btn-primary px-6 py-2.5"
                    disabled={busy || (info.step === "sign_simple" && !agree)}
                    title={info.step === "sign_simple" && !agree ? t("need_consent") : undefined}
                    onClick={submit}
                  >
                    {busy && <Spinner className="h-4 w-4 text-white" />} {info.step === "sign_simple" ? t("sign_document") : t("submit_data")}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <SignaturePad
        open={!!pad}
        kind={pad?.type === "initials" ? "initials" : "signature"}
        defaultName={info.recipient.name}
        onClose={() => setPad(null)}
        onDone={(png) => {
          if (!pad) return;
          savedSig.current[pad.type] = png;
          // Aplica a mesma assinatura/iniciais aos outros campos iguais ainda vazios.
          setValues((x) => {
            const n = { ...x, [pad.id]: png };
            for (const f of editable) if (f.type === pad.type && !n[f.id]) n[f.id] = png;
            return n;
          });
          setPad(null);
        }}
      />
    </div>
  );
}

function SignerField({ f, color, value, interactive, attention, heightPx, recipientName, fileName, token, session, compact, onOpen, onChange, onFile, onSign }: {
  f: SField; color: string; value: string | null; interactive: boolean; attention: boolean; heightPx: number;
  recipientName: string; fileName?: string; token: string; session: string;
  /** Ecrã pequeno: o campo é só um botão; preenche-se no painel de baixo, com letra grande. */
  compact: boolean; onOpen: () => void;
  onChange: (v: string) => void; onFile: (path: string, name: string) => void; onSign: () => void;
}) {
  const { t, field } = useT();
  const style: React.CSSProperties = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
  const fs = Math.max(9, Math.min(15, heightPx * 0.6));
  const ring = attention ? "ring-4 ring-amber-300" : "";
  const empty = !value;
  if (!interactive) {
    // Campos automáticos: mostra o que vai ficar escrito quando assinar.
    const preview = !value && isAutoField(f.type)
      ? f.type === "name" ? recipientName : f.type === "signed_date" ? new Date().toISOString().slice(0, 10) : null
      : null;
    return (
      <div className="absolute flex items-center justify-center overflow-hidden rounded-sm border border-dashed text-[10px]" style={{ ...style, borderColor: color, color, background: `${color}10` }} title={f.readonly ? t("fixed_value") : isAutoField(f.type) ? t("auto_value") : undefined}>
        {value || preview ? (
          <FieldValue type={f.type} value={value ?? preview} options={f.options} height={heightPx} />
        ) : f.type === "signature" ? t("cc_signature") : f.type === "email" ? t("your_email") : field(f.type)}
      </div>
    );
  }
  const box = `absolute overflow-hidden rounded-sm border-2 ${ring}`;
  const bg = empty ? `${color}1a` : "transparent";
  if (compact && f.type !== "signature" && f.type !== "initials") {
    const shown = f.type === "checkbox" ? (value === "true" ? "✓" : "")
      : f.type === "date" && value ? value.split("-").reverse().join("/")
      : f.type === "attachment" ? (fileName ?? (value ? t("file_loaded") : `📎 ${f.label || t("attach_file")}`))
      : value || `${f.label || field(f.type)}${f.required ? " *" : ""}`;
    return (
      <button
        data-field={f.id}
        className={`${box} flex items-center text-left ${f.type === "checkbox" ? "font-bold" : "px-1"}`}
        style={{ ...style, borderColor: color, background: empty ? `${color}1a` : "white", fontSize: fs, color: value ? "#0f2445" : color, justifyContent: f.type === "checkbox" ? "center" : undefined }}
        onClick={onOpen}
        aria-label={f.label || field(f.type)}
      >
        <span className="truncate">{shown}</span>
      </button>
    );
  }
  switch (f.type) {
    case "signature":
    case "initials":
      return (
        <button data-field={f.id} className={`${box} flex items-center justify-center`} style={{ ...style, borderColor: color, background: bg, color }} onClick={onSign} title={field(f.type)}>
          {value ? <img src={value} alt="" className="h-full w-full object-contain" /> : <span className="text-[11px] font-semibold">{f.type === "signature" ? t("sign_here") : field("initials")}{f.required ? " *" : ""}</span>}
        </button>
      );
    case "checkbox":
      return (
        <label data-field={f.id} className={`${box} flex cursor-pointer items-center justify-center`} style={{ ...style, borderColor: color, background: bg }}>
          <input type="checkbox" className="h-full w-full cursor-pointer opacity-0" checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "false")} aria-label={f.label ?? field("checkbox")} />
          {value === "true" && <span className="pointer-events-none absolute font-bold" style={{ fontSize: fs, color: "#0f2445" }}>✓</span>}
        </label>
      );
    case "radio":
      return (
        <div data-field={f.id} className={`${box} flex flex-col justify-around bg-white/70 px-1`} style={{ ...style, borderColor: color }} role="radiogroup" aria-label={f.label ?? field("radio")}>
          {(f.options ?? []).map((o) => (
            <label key={o} className="flex cursor-pointer items-center gap-1 truncate" style={{ fontSize: Math.max(9, Math.min(13, heightPx / (f.options?.length || 1) * 0.6)) }}>
              <input type="radio" name={f.id} checked={value === o} onChange={() => onChange(o)} /> {o}
            </label>
          ))}
        </div>
      );
    case "dropdown":
      return (
        <select data-field={f.id} className={`${box} bg-white px-1`} style={{ ...style, borderColor: color, fontSize: fs }} value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={f.label ?? field("dropdown")}>
          <option value="">{f.label ?? t("choose")}</option>
          {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case "attachment":
      return <AttachmentField f={f} box={box} style={{ ...style, borderColor: color, background: bg, color }} fs={fs} fileName={fileName ?? (value ? t("file_loaded") : undefined)} token={token} session={session} onFile={onFile} />;
    case "date":
      return <input data-field={f.id} type="date" className={`${box} bg-white px-1`} style={{ ...style, borderColor: color, fontSize: fs }} value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={f.label ?? field("date")} />;
    default:
      return (
        <input
          data-field={f.id}
          className={`${box} bg-white px-1 outline-none`}
          style={{ ...style, borderColor: color, background: empty ? `${color}12` : "white", fontSize: fs }}
          value={value ?? ""}
          placeholder={f.label ?? field("text")}
          maxLength={500}
          onChange={(e) => onChange(e.target.value)}
          aria-label={f.label ?? field("text")}
        />
      );
  }
}

/** Carregamento de um anexo do signatário (usado no campo e no painel de baixo). */
function useAttachmentUpload(f: SField, token: string, session: string, onFile: (path: string, name: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t, error: errText } = useT();
  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > 10 * 1024 * 1024) return setError(t("file_too_big"));
    if (!/\.(pdf|jpe?g|png)$/i.test(file.name)) return setError(t("file_type"));
    setBusy(true);
    try {
      const u = await signerApi<{ path: string; uploadToken: string }>({ action: "attachment-upload-url", token, session, field_id: f.id, file_name: file.name });
      const up = await anon.storage.from(BUCKET).uploadToSignedUrl(u.path, u.uploadToken, file, { contentType: file.type || "application/octet-stream" });
      if (up.error) throw up.error;
      onFile(u.path, file.name);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, pick };
}

function AttachmentField({ f, box, style, fs, fileName, token, session, onFile }: {
  f: SField; box: string; style: React.CSSProperties; fs: number; fileName?: string; token: string; session: string; onFile: (path: string, name: string) => void;
}) {
  const { t } = useT();
  const { busy, error, pick } = useAttachmentUpload(f, token, session, onFile);
  return (
    <label data-field={f.id} className={`${box} flex cursor-pointer items-center justify-center gap-1 px-1`} style={style} title={error ?? f.label ?? t("attach_file")}>
      <input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" className="sr-only" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} disabled={busy} />
      <span className="truncate font-semibold" style={{ fontSize: Math.min(fs, 12), color: error ? "#b91c1c" : undefined }}>
        {busy ? t("uploading") : error ? `⚠ ${error}` : fileName ? `📎 ${fileName}` : `📎 ${f.label || t("attach_file")}${f.required ? " *" : ""}`}
      </span>
    </label>
  );
}

function DelegateModal({ open, onClose, token, session, mode, onDone }: { open: boolean; onClose: () => void; token: string; session: string; mode: "simple" | "qualified"; onDone: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t, error: errText } = useT();
  return (
    <Modal open={open} onClose={onClose} title={t("delegate_title")}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await signerApi({ action: "delegate", token, session, name, email, reason });
            onDone();
          } catch (err) {
            setError(errText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-slate-600">
          {t("delegate_intro")}
          {mode === "qualified" && ` ${t("delegate_intro_cc")}`}
        </p>
        <div>
          <label className="label" htmlFor="dname">{t("full_name")}</label>
          <input id="dname" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
        </div>
        <div>
          <label className="label" htmlFor="demail">{t("email")}</label>
          <input id="demail" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="dreason">{t("reason_optional")}</label>
          <textarea id="dreason" className="input min-h-20" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder={t("delegate_reason_ph")} />
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-secondary" onClick={onClose}>{t("back")}</button>
          <button className="btn-primary" disabled={busy || !name.trim() || !email.trim()}>{busy && <Spinner className="h-4 w-4 text-white" />} {t("delegate")}</button>
        </div>
      </form>
    </Modal>
  );
}

function CcWizard({ token, session, info, onDone, onFinished }: { token: string; session: string; info: LoadInfo; onDone: (completed: boolean) => void; onFinished: (k: "signed") => void }) {
  const [downloaded, setDownloaded] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const { t, tn, error: errText } = useT();

  async function download() {
    setError(null);
    try {
      const r = await signerApi<{ url: string; fileName: string }>({ action: "cc-download", token, session });
      window.location.href = r.url;
      setDownloaded(true);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function upload() {
    if (!file) return;
    setError(null);
    try {
      if (file.size > 30 * 1024 * 1024) throw new Error(t("cc_too_big"));
      setBusy(t("uploading"));
      const u = await signerApi<{ path: string; uploadToken: string }>({ action: "cc-upload-url", token, session });
      const up = await anon.storage.from(BUCKET).uploadToSignedUrl(u.path, u.uploadToken, file, { contentType: "application/pdf" });
      if (up.error) throw up.error;
      setBusy(t("cc_validating"));
      const r = await signerApi<{ ok: boolean; signer: string; completed: boolean }>({ action: "cc-submit", token, session, path: u.path });
      setOk(r.signer);
      setTimeout(() => (r.completed ? onFinished("signed") : onDone(false)), 1800);
    } catch (e) {
      setError(errText(e));
      setFile(null);
    } finally {
      setBusy(null);
    }
  }

  const Step = ({ n, title, children, done }: { n: number; title: string; children: React.ReactNode; done?: boolean }) => (
    <li className="flex gap-4">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${done ? "bg-emerald-600 text-white" : "bg-navy-900 text-white"}`}>
        {done ? <CheckIcon className="h-4 w-4" /> : n}
      </span>
      <div className="min-w-0 flex-1 pb-6">
        <h3 className="font-semibold">{title}</h3>
        <div className="mt-1 text-sm text-slate-600">{children}</div>
      </div>
    </li>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[420px_1fr]">
      <div className="card h-fit p-5 lg:sticky lg:top-20">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><IdIcon className="h-5 w-5" /> {t("cc_title")}</h2>
        <ol className="mt-5">
          <Step n={1} title={t("cc_s1")}>
            {tn("cc_s1_body", { app: <a className="text-navy-600 underline" href="https://www.autenticacao.gov.pt" target="_blank" rel="noreferrer">Autenticação.gov</a> })}
            <ul className="mt-1 list-disc pl-5">
              <li>{t("cc_s1_card")}</li>
              <li>{t("cc_s1_cmd")}</li>
            </ul>
          </Step>
          <Step n={2} title={t("cc_s2")} done={downloaded}>
            <button className="btn-secondary mt-2" onClick={download}><DownloadIcon className="h-4 w-4" /> {t("cc_s2_btn")}</button>
            <p className="mt-2 text-xs">{t("cc_s2_note")}</p>
          </Step>
          <Step n={3} title={t("cc_s3")}>
            {t("cc_s3_body")}
          </Step>
          <Step n={4} title={t("cc_s4")} done={!!ok}>
            {ok ? (
              <Alert kind="success">{tn("cc_valid", { name: <strong>{ok}</strong> })}</Alert>
            ) : (
              <>
                <label className="mt-2 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-3 py-5 text-center hover:bg-slate-100">
                  <UploadIcon className="h-6 w-6 text-slate-400" />
                  <span className="mt-1 text-sm">{file ? file.name : t("cc_choose")}</span>
                  <input type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
                </label>
                <button className="btn-primary mt-3 w-full" disabled={!file || !!busy} onClick={upload}>
                  {busy ? <><Spinner className="h-4 w-4 text-white" /> {busy}</> : t("cc_send")}
                </button>
              </>
            )}
            {error && <div className="mt-3"><Alert>{error}</Alert></div>}
          </Step>
        </ol>
      </div>
      <div className="min-w-0">
        <PdfPages src={info.pdfUrl} parts={info.document.parts} />
      </div>
    </div>
  );
}

function DeclineModal({ open, onClose, token, session, onDone }: { open: boolean; onClose: () => void; token: string; session: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t, error: errText } = useT();
  return (
    <Modal open={open} onClose={onClose} title={t("decline_title")}>
      <p className="text-sm text-slate-600">{t("decline_intro")}</p>
      <label className="label mt-4" htmlFor="reason">{t("reason_optional")}</label>
      <textarea id="reason" className="input min-h-24" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>{t("back")}</button>
        <button
          className="btn bg-red-700 text-white hover:bg-red-800"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await signerApi({ action: "decline", token, session, reason });
              onDone();
            } catch (e) {
              setError(errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("decline")}
        </button>
      </div>
    </Modal>
  );
}

function Done({ kind, title, hostDoc }: { kind: "signed" | "filled" | "declined" | "delegated"; title: string; hostDoc?: string | null }) {
  const { t } = useT();
  return (
    <div className="mx-auto mt-10 max-w-md text-center">
      <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${kind === "declined" ? "bg-slate-200 text-slate-600" : "bg-emerald-100 text-emerald-700"}`}>
        {kind === "declined" ? "✕" : kind === "delegated" ? "→" : <CheckIcon className="h-7 w-7" />}
      </div>
      <h1 className="mt-4 text-xl font-semibold">
        {t(kind === "signed" ? "done_signed" : kind === "filled" ? "done_filled" : kind === "delegated" ? "done_delegated" : "done_declined")}
      </h1>
      <p className="muted mt-2">
        {kind === "signed" && t("done_signed_body", { title })}
        {kind === "filled" && t("done_filled_body")}
        {kind === "declined" && t("done_declined_body")}
        {kind === "delegated" && t("done_delegated_body")}
      </p>
      {hostDoc ? (
        <div className="mt-6">
          <p className="text-sm text-slate-600">{t("in_person_return")}</p>
          <Link to={`/documentos/${hostDoc}`} className="btn-secondary mt-3">Voltar ao documento (colaborador)</Link>
        </div>
      ) : (
        <p className="mt-6 text-xs text-slate-500">{t("close_page")}</p>
      )}
    </div>
  );
}

/** Ecrã estreito (telemóvel na vertical). */
function useIsSmall(): boolean {
  const q = "(max-width: 639px)";
  const [small, setSmall] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const h = () => setSmall(m.matches);
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, []);
  return small;
}

/** Painel de baixo: um campo de cada vez, com controlos de tamanho normal. */
function FieldSheet({ f, index, total, value, fileName, token, session, onChange, onFile, onSign, onPrev, onNext, onClose }: {
  f: SField; index: number; total: number; value: string | null; fileName?: string; token: string; session: string;
  onChange: (v: string) => void; onFile: (path: string, name: string) => void; onSign: () => void;
  onPrev: () => void; onNext: () => void; onClose: () => void;
}) {
  const { t, field } = useT();
  const { busy, error, pick } = useAttachmentUpload(f, token, session, onFile);
  const label = f.label || field(f.type);
  let input: React.ReactNode;
  switch (f.type) {
    case "signature":
    case "initials":
      input = value ? (
        <div className="flex items-center gap-3">
          <img src={value} alt="" className="h-14 max-w-[60%] rounded border border-slate-200 bg-white object-contain" />
          <button className="btn-secondary" onClick={onSign}>{t("change")}</button>
        </div>
      ) : (
        <button className="btn-primary w-full py-3" onClick={onSign}>{f.type === "signature" ? t("sign_here") : field("initials")}</button>
      );
      break;
    case "checkbox":
      input = (
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-3 text-base">
          <input type="checkbox" className="h-5 w-5" checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "false")} />
          {label}
        </label>
      );
      break;
    case "radio":
      input = (
        <div className="space-y-1.5" role="radiogroup" aria-label={label}>
          {(f.options ?? []).map((o) => (
            <label key={o} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-base ${value === o ? "border-navy-500 bg-navy-50" : "border-slate-200"}`}>
              <input type="radio" name={`sheet-${f.id}`} className="h-5 w-5" checked={value === o} onChange={() => onChange(o)} /> {o}
            </label>
          ))}
        </div>
      );
      break;
    case "dropdown":
      input = (
        <select className="input text-base" value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={label}>
          <option value="">{t("choose")}</option>
          {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
      break;
    case "date":
      input = <input type="date" className="input text-base" value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={label} />;
      break;
    case "attachment":
      input = (
        <>
          <label className={`btn-secondary w-full cursor-pointer justify-center py-3 ${busy ? "pointer-events-none opacity-60" : ""}`}>
            <input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" className="sr-only" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} disabled={busy} />
            {busy ? t("uploading") : fileName ? `📎 ${fileName}` : value ? `📎 ${t("file_loaded")}` : `📎 ${t("attach_file")}`}
          </label>
          {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        </>
      );
      break;
    default:
      input = (
        <input
          className="input text-base"
          value={value ?? ""}
          maxLength={500}
          autoFocus
          enterKeyHint={index === total ? "done" : "next"}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onNext()}
          aria-label={label}
        />
      );
  }
  return (
    <div className="mx-auto max-w-xl px-4 pt-2 pb-3">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{t("field_of", { i: index, n: total })}</span>
        <button className="px-2 py-1 font-medium text-slate-600 hover:text-slate-900" onClick={onClose}>{t("close")}</button>
      </div>
      <p className="mb-2 font-medium text-slate-900">
        {label} {f.required ? <span className="text-red-700">*</span> : <span className="text-xs font-normal text-slate-500">({t("optional")})</span>}
      </p>
      {input}
      <div className="mt-3 flex gap-2">
        <button className="btn-secondary" onClick={onPrev} disabled={index === 1}>{t("previous")}</button>
        <button className="btn-primary flex-1 justify-center py-2.5" onClick={onNext}>{index === total ? t("finish_fields") : t("next")}</button>
      </div>
    </div>
  );
}
