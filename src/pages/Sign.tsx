import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { createClient } from "@supabase/supabase-js";
import { ApiError, signerApi } from "../lib/api";
import { SUPABASE_ANON_KEY, SUPABASE_URL, BUCKET } from "../lib/supabase";
import type { FieldType } from "../../supabase/functions/_shared/types";
import { FIELD_LABELS } from "../../supabase/functions/_shared/types";
import { PdfPages } from "../components/PdfPages";
import { SignaturePad } from "../components/SignaturePad";
import { FieldValue } from "../components/FieldBox";
import { Alert, CheckIcon, DownloadIcon, FullPageSpinner, IdIcon, Logo, Modal, Spinner, UploadIcon } from "../components/ui";
import { errorMessage } from "../lib/format";

// Cliente sem sessão (o signatário não tem conta).
const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: "signed-signer" } });

interface StartInfo {
  recipient: { name: string; email: string; status: string };
  document: { title: string; status: string; sender: string; mode: "simple" | "qualified" };
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
  const [finished, setFinished] = useState<null | "signed" | "filled" | "declined">(null);

  useEffect(() => {
    signerApi<StartInfo>({ action: "start", token })
      .then(setStart)
      .catch((e) => setFatal(errorMessage(e)));
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
      } else setFatal(errorMessage(e));
    }
  }

  useEffect(() => {
    if (session && start) load(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, start]);

  return (
    <div className="min-h-full bg-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <Logo />
          {start && <p className="min-w-0 truncate text-sm text-slate-600">{start.document.title}</p>}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {fatal ? (
          <Centered>
            <Alert>{fatal}</Alert>
          </Centered>
        ) : !start ? (
          <FullPageSpinner />
        ) : finished ? (
          <Done kind={finished} title={start.document.title} />
        ) : start.document.status !== "in_progress" ? (
          <Centered>
            <Alert kind="info">
              {{
                completed: "Este documento já foi assinado por todos. Recebeu (ou vai receber) uma cópia por email.",
                declined: "Este documento foi rejeitado e já não pode ser assinado.",
                cancelled: "O remetente cancelou este documento.",
                expired: "O prazo para assinar este documento terminou.",
              }[start.document.status] ?? "Este documento não está disponível."}
            </Alert>
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
          <FullPageSpinner label="A abrir o documento…" />
        ) : (
          <Flow token={token} session={session} info={info} reload={() => load()} onFinished={setFinished} />
        )}
      </main>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto mt-10 max-w-md">{children}</div>;
}

function Otp({ token, start, onSession }: { token: string; start: StartInfo; onSession: (s: string) => void }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await signerApi({ action: "send-otp", token });
      setSent(true);
    } catch (e) {
      setError(errorMessage(e));
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
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-6 max-w-md">
      <div className="card p-6">
        <p className="text-sm text-slate-500">{start.document.sender} enviou-lhe</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{start.document.title}</h1>
        {start.document.mode === "qualified" && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-navy-50 p-3 text-sm text-navy-800">
            <IdIcon className="mt-0.5 h-4 w-4 shrink-0" />
            Este documento é assinado com Cartão de Cidadão ou Chave Móvel Digital.
          </p>
        )}
        <div className="mt-5 border-t border-slate-100 pt-5">
          <p className="text-sm">
            Olá <strong>{start.recipient.name}</strong>. Para proteger o documento, vamos enviar um código de 6 dígitos para <strong>{start.recipient.email}</strong>.
          </p>
          {!sent ? (
            <button className="btn-primary mt-4 w-full py-2.5" onClick={send} disabled={busy}>
              {busy && <Spinner className="h-4 w-4 text-white" />} Enviar código
            </button>
          ) : (
            <form onSubmit={verify} className="mt-4 space-y-3">
              <label className="label" htmlFor="code">Código recebido por email</label>
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
                {busy && <Spinner className="h-4 w-4 text-white" />} Abrir documento
              </button>
              <button type="button" className="btn-ghost w-full" onClick={send} disabled={busy}>Reenviar código</button>
            </form>
          )}
          {error && <div className="mt-3"><Alert>{error}</Alert></div>}
        </div>
      </div>
      <p className="mt-4 text-center text-xs text-slate-500">Signed · plataforma de assinatura eletrónica do Grupo Altis Hotels</p>
    </div>
  );
}

function Flow({ token, session, info, reload, onFinished }: { token: string; session: string; info: LoadInfo; reload: () => void; onFinished: (k: "signed" | "filled" | "declined") => void }) {
  const [declining, setDeclining] = useState(false);

  const header = (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-sm text-slate-500">De {info.document.sender}</p>
        <h1 className="text-xl font-semibold tracking-tight">{info.document.title}</h1>
      </div>
      {info.step !== "done" && info.step !== "wait" && (
        <button className="btn-ghost text-red-700" onClick={() => setDeclining(true)}>Rejeitar</button>
      )}
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
            {info.recipient.status === "filled"
              ? "Obrigado, os seus dados foram registados. Vai receber um novo email quando chegar a sua vez de assinar com o Cartão de Cidadão."
              : "Ainda não é a sua vez. Vai receber um email quando puder avançar."}
          </Alert>
        </div>
      )}
      {info.step === "done" && (
        <div className="mb-5"><Alert kind="success">Já assinou este documento. Obrigado!</Alert></div>
      )}
      {info.step === "sign_cc" ? (
        <CcWizard token={token} session={session} info={info} onDone={(completed) => (completed ? onFinished("signed") : reload())} onFinished={onFinished} />
      ) : (
        <FillAndSign token={token} session={session} info={info} onFinished={onFinished} />
      )}
      <DeclineModal open={declining} onClose={() => setDeclining(false)} token={token} session={session} onDone={() => onFinished("declined")} />
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
  const [pad, setPad] = useState<SField | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attention, setAttention] = useState<string | null>(null);
  const savedSig = useRef<Record<string, string>>({});

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
      setError(errorMessage(e));
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
            {missing.length ? <>Faltam <strong>{missing.length}</strong> campo(s) obrigatório(s).</> : <span className="text-emerald-700">Todos os campos obrigatórios estão preenchidos.</span>}
            {info.step === "fill" && <span className="block text-xs text-slate-500">Nesta fase só preenche os dados. A assinatura com o Cartão de Cidadão vem a seguir.</span>}
          </span>
          {missing.length > 0 && <button className="btn-primary" onClick={goNext}>{Object.keys(values).length ? "Seguinte" : "Começar"}</button>}
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
                  onChange={(v) => setValues((x) => ({ ...x, [f.id]: v }))}
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
                Li o documento e concordo em assiná-lo eletronicamente. Aceito que a assinatura eletrónica, a data, a hora e o endereço IP fiquem registados como prova.
              </label>
            ) : (
              <p className="flex-1 text-xs text-slate-600">Confirme que os dados estão corretos antes de submeter. Depois de submetidos não podem ser alterados.</p>
            )}
            {error && <div className="sm:max-w-sm"><Alert>{error}</Alert></div>}
            <button className="btn-primary px-6 py-2.5" disabled={busy || missing.length > 0 || (info.step === "sign_simple" && !agree)} onClick={submit}>
              {busy && <Spinner className="h-4 w-4 text-white" />} {info.step === "sign_simple" ? "Assinar documento" : "Submeter dados"}
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

function SignerField({ f, color, value, interactive, attention, heightPx, onChange, onSign }: {
  f: SField; color: string; value: string | null; interactive: boolean; attention: boolean; heightPx: number; onChange: (v: string) => void; onSign: () => void;
}) {
  const style: React.CSSProperties = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
  const fs = Math.max(9, Math.min(15, heightPx * 0.6));
  const ring = attention ? "ring-4 ring-amber-300" : "";
  const empty = !value;
  if (!interactive) {
    return (
      <div className="absolute flex items-center justify-center overflow-hidden rounded-sm border border-dashed text-[10px]" style={{ ...style, borderColor: color, color, background: `${color}10` }}>
        {value ? <FieldValue type={f.type} value={value} options={f.options} height={heightPx} /> : f.type === "signature" ? "Assinatura com Cartão de Cidadão" : FIELD_LABELS[f.type]}
      </div>
    );
  }
  const box = `absolute overflow-hidden rounded-sm border-2 ${ring}`;
  const bg = empty ? `${color}1a` : "transparent";
  switch (f.type) {
    case "signature":
    case "initials":
      return (
        <button data-field={f.id} className={`${box} flex items-center justify-center`} style={{ ...style, borderColor: color, background: bg, color }} onClick={onSign} title={FIELD_LABELS[f.type]}>
          {value ? <img src={value} alt="" className="h-full w-full object-contain" /> : <span className="text-[11px] font-semibold">{f.type === "signature" ? "✍ Assinar" : "Iniciais"}{f.required ? " *" : ""}</span>}
        </button>
      );
    case "checkbox":
      return (
        <label data-field={f.id} className={`${box} flex cursor-pointer items-center justify-center`} style={{ ...style, borderColor: color, background: bg }}>
          <input type="checkbox" className="h-full w-full cursor-pointer opacity-0" checked={value === "true"} onChange={(e) => onChange(e.target.checked ? "true" : "false")} aria-label={f.label ?? "Caixa de seleção"} />
          {value === "true" && <span className="pointer-events-none absolute font-bold" style={{ fontSize: fs, color: "#0f2445" }}>✓</span>}
        </label>
      );
    case "radio":
      return (
        <div data-field={f.id} className={`${box} flex flex-col justify-around bg-white/70 px-1`} style={{ ...style, borderColor: color }} role="radiogroup" aria-label={f.label ?? "Opção"}>
          {(f.options ?? []).map((o) => (
            <label key={o} className="flex cursor-pointer items-center gap-1 truncate" style={{ fontSize: Math.max(9, Math.min(13, heightPx / (f.options?.length || 1) * 0.6)) }}>
              <input type="radio" name={f.id} checked={value === o} onChange={() => onChange(o)} /> {o}
            </label>
          ))}
        </div>
      );
    case "dropdown":
      return (
        <select data-field={f.id} className={`${box} bg-white px-1`} style={{ ...style, borderColor: color, fontSize: fs }} value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={f.label ?? "Lista"}>
          <option value="">{f.label ?? "Escolher…"}</option>
          {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case "date":
      return <input data-field={f.id} type="date" className={`${box} bg-white px-1`} style={{ ...style, borderColor: color, fontSize: fs }} value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={f.label ?? "Data"} />;
    default:
      return (
        <input
          data-field={f.id}
          className={`${box} bg-white px-1 outline-none`}
          style={{ ...style, borderColor: color, background: empty ? `${color}12` : "white", fontSize: fs }}
          value={value ?? ""}
          placeholder={f.label ?? "Texto"}
          maxLength={500}
          onChange={(e) => onChange(e.target.value)}
          aria-label={f.label ?? "Texto"}
        />
      );
  }
}

function CcWizard({ token, session, info, onDone, onFinished }: { token: string; session: string; info: LoadInfo; onDone: (completed: boolean) => void; onFinished: (k: "signed") => void }) {
  const [downloaded, setDownloaded] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function download() {
    setError(null);
    try {
      const r = await signerApi<{ url: string; fileName: string }>({ action: "cc-download", token, session });
      window.location.href = r.url;
      setDownloaded(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function upload() {
    if (!file) return;
    setError(null);
    try {
      if (file.size > 30 * 1024 * 1024) throw new Error("O ficheiro é demasiado grande.");
      setBusy("A carregar…");
      const u = await signerApi<{ path: string; uploadToken: string }>({ action: "cc-upload-url", token, session });
      const up = await anon.storage.from(BUCKET).uploadToSignedUrl(u.path, u.uploadToken, file, { contentType: "application/pdf" });
      if (up.error) throw up.error;
      setBusy("A validar a assinatura…");
      const r = await signerApi<{ ok: boolean; signer: string; completed: boolean }>({ action: "cc-submit", token, session, path: u.path });
      setOk(r.signer);
      setTimeout(() => (r.completed ? onFinished("signed") : onDone(false)), 1800);
    } catch (e) {
      setError(errorMessage(e));
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
        <h2 className="flex items-center gap-2 text-lg font-semibold"><IdIcon className="h-5 w-5" /> Assinar com Cartão de Cidadão</h2>
        <ol className="mt-5">
          <Step n={1} title="Prepare o computador">
            Precisa da app gratuita <a className="text-navy-600 underline" href="https://www.autenticacao.gov.pt" target="_blank" rel="noreferrer">Autenticação.gov</a> e de:
            <ul className="mt-1 list-disc pl-5">
              <li>Cartão de Cidadão + leitor de cartões + PIN de assinatura; ou</li>
              <li>Chave Móvel Digital ativa com assinatura (telemóvel + PIN).</li>
            </ul>
          </Step>
          <Step n={2} title="Descarregue o documento" done={downloaded}>
            <button className="btn-secondary mt-2" onClick={download}><DownloadIcon className="h-4 w-4" /> Descarregar PDF para assinar</button>
            <p className="mt-2 text-xs">Não abra nem guarde o PDF noutro programa antes de assinar.</p>
          </Step>
          <Step n={3} title="Assine na app Autenticação.gov">
            Abra a app, escolha <strong>Assinatura</strong>, adicione o PDF descarregado e coloque a assinatura visível no retângulo azul «Assinatura qualificada». Assine com o Cartão de Cidadão ou a Chave Móvel Digital e guarde o ficheiro assinado.
          </Step>
          <Step n={4} title="Carregue o PDF assinado" done={!!ok}>
            {ok ? (
              <Alert kind="success">Assinatura válida de <strong>{ok}</strong>. Obrigado!</Alert>
            ) : (
              <>
                <label className="mt-2 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-3 py-5 text-center hover:bg-slate-100">
                  <UploadIcon className="h-6 w-6 text-slate-400" />
                  <span className="mt-1 text-sm">{file ? file.name : "Escolher o PDF assinado"}</span>
                  <input type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
                </label>
                <button className="btn-primary mt-3 w-full" disabled={!file || !!busy} onClick={upload}>
                  {busy ? <><Spinner className="h-4 w-4 text-white" /> {busy}</> : "Enviar documento assinado"}
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
  return (
    <Modal open={open} onClose={onClose} title="Rejeitar documento">
      <p className="text-sm text-slate-600">O remetente será avisado e o documento deixa de poder ser assinado por todos.</p>
      <label className="label mt-4" htmlFor="reason">Motivo (opcional)</label>
      <textarea id="reason" className="input min-h-24" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>Voltar</button>
        <button
          className="btn bg-red-700 text-white hover:bg-red-800"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await signerApi({ action: "decline", token, session, reason });
              onDone();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Rejeitar
        </button>
      </div>
    </Modal>
  );
}

function Done({ kind, title }: { kind: "signed" | "filled" | "declined"; title: string }) {
  return (
    <div className="mx-auto mt-10 max-w-md text-center">
      <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${kind === "declined" ? "bg-slate-200 text-slate-600" : "bg-emerald-100 text-emerald-700"}`}>
        {kind === "declined" ? "✕" : <CheckIcon className="h-7 w-7" />}
      </div>
      <h1 className="mt-4 text-xl font-semibold">
        {kind === "signed" ? "Documento assinado" : kind === "filled" ? "Dados submetidos" : "Documento rejeitado"}
      </h1>
      <p className="muted mt-2">
        {kind === "signed" && `Obrigado. Quando todos assinarem «${title}», recebe uma cópia final por email.`}
        {kind === "filled" && "Obrigado. Vai receber um email quando chegar a sua vez de assinar com o Cartão de Cidadão."}
        {kind === "declined" && "O remetente foi avisado."}
      </p>
      <p className="mt-6 text-xs text-slate-400">Pode fechar esta página.</p>
    </div>
  );
}
