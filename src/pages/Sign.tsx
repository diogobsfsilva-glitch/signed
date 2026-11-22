import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { createClient } from "@supabase/supabase-js";
import { ApiError, signerApi } from "../lib/api";
import { SUPABASE_ANON_KEY, SUPABASE_URL, BUCKET } from "../lib/supabase";
import type { FieldType } from "../../supabase/functions/_shared/types";
import { isAutoField } from "../../supabase/functions/_shared/types";
import { PdfPages } from "../components/PdfPages";
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
  document: { id: string; title: string; status: string; mode: "simple" | "qualified"; phase: "fill" | "sign"; message: string | null; sender: string; expires_at: string | null };
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
  const [chosen, setChosen] = useState<Lang | null>(() => {
    try {
      const v = localStorage.getItem("signed:lang");
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
      localStorage.setItem("signed:lang", l);
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
    const v: Record<string, string> = {};
    const today = new Date().toISOString().slice(0, 10);
    for (const f of info.fields) {
      if (f.value) v[f.id] = f.value;
      else if (f.type === "date" && f.editable) v[f.id] = today;
    }
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
  const missing = editable.filter((f) => f.required && !(f.type === "checkbox" ? values[f.id] === "true" : values[f.id]));
  const ordered = useMemo(() => [...editable].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x), [editable]);

  function goNext() {
    const next = ordered.find((f) => f.required && !(f.type === "checkbox" ? values[f.id] === "true" : values[f.id])) ?? ordered[0];
    if (!next) return;
    const el = document.querySelector(`[data-field="${next.id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    setAttention(next.id);
    setTimeout(() => setAttention(null), 1600);
    if ((next.type === "signature" || next.type === "initials") && !values[next.id]) setPad(next);
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

  return (
    <div className="pb-40">
      {interactive && editable.length > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-white px-4 py-3 text-sm shadow-sm">
          <span>
            {missing.length ? tn("missing", { n: <strong>{missing.length}</strong> }) : <span className="text-emerald-700">{t("all_filled")}</span>}
            {info.step === "fill" && <span className="block text-xs text-slate-500">{t("fill_phase_note")}</span>}
          </span>
          {missing.length > 0 && <button className="btn-primary" onClick={goNext}>{Object.keys(values).length ? t("next") : t("start")}</button>}
        </div>
      )}

      <div className="mx-auto max-w-[860px]">
        <PdfPages
          src={info.pdfUrl}
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
                  attention={attention === f.id}
                  heightPx={f.h * size.height}
                  recipientName={info.recipient.name}
                  fileName={fileNames[f.id]}
                  token={token}
                  session={session}
                  onChange={(v) => setValues((x) => ({ ...x, [f.id]: v }))}
                  onFile={(path, name) => {
                    setValues((x) => ({ ...x, [f.id]: path }));
                    setFileNames((x) => ({ ...x, [f.id]: name }));
                  }}
                  onSign={() => setPad(f)}
                />
              ))}
            </>
          )}
        />
      </div>

      {interactive && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
            {info.step === "sign_simple" ? (
              <label className="flex flex-1 items-start gap-2 text-xs text-slate-600">
                <input type="checkbox" className="mt-0.5" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                {t("consent_sign")}
              </label>
            ) : (
              <p className="flex-1 text-xs text-slate-600">{t("consent_fill")}</p>
            )}
            {error && <div className="sm:max-w-sm"><Alert>{error}</Alert></div>}
            <button className="btn-primary px-6 py-2.5" disabled={busy || missing.length > 0 || (info.step === "sign_simple" && !agree)} onClick={submit}>
              {busy && <Spinner className="h-4 w-4 text-white" />} {info.step === "sign_simple" ? t("sign_document") : t("submit_data")}
            </button>
          </div>
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

function SignerField({ f, color, value, interactive, attention, heightPx, recipientName, fileName, token, session, onChange, onFile, onSign }: {
  f: SField; color: string; value: string | null; interactive: boolean; attention: boolean; heightPx: number;
  recipientName: string; fileName?: string; token: string; session: string;
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

function AttachmentField({ f, box, style, fs, fileName, token, session, onFile }: {
  f: SField; box: string; style: React.CSSProperties; fs: number; fileName?: string; token: string; session: string; onFile: (path: string, name: string) => void;
}) {
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
  return (
    <label data-field={f.id} className={`${box} flex cursor-pointer items-center justify-center gap-1 px-1`} style={style} title={error ?? f.label ?? "Anexo"}>
      <input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />
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
        <PdfPages src={info.pdfUrl} />
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
        <p className="mt-6 text-xs text-slate-400">{t("close_page")}</p>
      )}
    </div>
  );
}
