// Janelas de confirmação e de texto da aplicação (substituem confirm() e prompt() do navegador).
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Modal } from "./ui";

interface AskOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

function mount<T>(render: (done: (v: T) => void) => React.ReactNode): Promise<T> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: T) => {
      root.unmount();
      host.remove();
      resolve(v);
    };
    root.render(render(done));
  });
}

/** Pede confirmação. Devolve true se a pessoa confirmar. */
export function confirmAction(o: AskOptions): Promise<boolean> {
  return mount<boolean>((done) => <ConfirmDialog {...o} onDone={done} />);
}

/** Pede um texto (ex.: nome de um modelo). Devolve null se cancelar. */
export function promptText(o: AskOptions & { label: string; defaultValue?: string; maxLength?: number }): Promise<string | null> {
  return mount<string | null>((done) => <PromptDialog {...o} onDone={done} />);
}

function ConfirmDialog({ title, message, confirmLabel = "Confirmar", cancelLabel = "Voltar", danger, onDone }: AskOptions & { onDone: (v: boolean) => void }) {
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => ok.current?.focus(), []);
  return (
    <Modal open onClose={() => onDone(false)} title={title}>
      {message && <p className="text-sm text-slate-700">{message}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-secondary" onClick={() => onDone(false)}>{cancelLabel}</button>
        <button ref={ok} className={danger ? "btn-danger" : "btn-primary"} onClick={() => onDone(true)}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

function PromptDialog({ title, message, label, defaultValue = "", maxLength = 200, confirmLabel = "Guardar", cancelLabel = "Cancelar", onDone }: AskOptions & { label: string; defaultValue?: string; maxLength?: number; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(defaultValue);
  return (
    <Modal open onClose={() => onDone(null)} title={title}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) onDone(v.trim());
        }}
      >
        {message && <p className="mb-3 text-sm text-slate-700">{message}</p>}
        <label className="label" htmlFor="prompt-input">{label}</label>
        <input id="prompt-input" className="input" autoFocus value={v} maxLength={maxLength} onChange={(e) => setV(e.target.value)} onFocus={(e) => e.target.select()} />
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => onDone(null)}>{cancelLabel}</button>
          <button type="submit" className="btn-primary" disabled={!v.trim()}>{confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
