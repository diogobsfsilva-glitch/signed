import { useEffect, useState, type ReactNode } from "react";
import type { DocStatus, RecipientStatus } from "../../supabase/functions/_shared/types";
import { RECIPIENT_STATUS_LABELS, STATUS_LABELS } from "../../supabase/functions/_shared/types";

export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={`animate-spin text-navy-600 ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function FullPageSpinner({ label }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-3">
      <Spinner className="h-7 w-7" />
      {label && <p className="muted">{label}</p>}
    </div>
  );
}

const STATUS_STYLE: Record<DocStatus, string> = {
  draft: "bg-slate-100 text-slate-700 ring-slate-200",
  in_progress: "bg-amber-50 text-amber-800 ring-amber-200",
  completed: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  declined: "bg-red-50 text-red-700 ring-red-200",
  expired: "bg-slate-100 text-slate-600 ring-slate-200",
  cancelled: "bg-slate-100 text-slate-600 ring-slate-200",
};

export function StatusBadge({ status }: { status: DocStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_STYLE[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

const R_STYLE: Record<RecipientStatus, string> = {
  pending: "text-slate-500",
  notified: "text-amber-700",
  viewed: "text-sky-700",
  filled: "text-indigo-700",
  signed: "text-emerald-700",
  declined: "text-red-700",
};

export function RecipientBadge({ status }: { status: RecipientStatus }) {
  return <span className={`text-xs font-medium ${R_STYLE[status]}`}>{RECIPIENT_STATUS_LABELS[status]}</span>;
}

export function ModeBadge({ mode }: { mode: "simple" | "qualified" }) {
  return mode === "qualified" ? (
    <span className="inline-flex items-center gap-1 rounded-md bg-navy-50 px-2 py-0.5 text-xs font-medium text-navy-700 ring-1 ring-inset ring-navy-200">
      <IdIcon className="h-3.5 w-3.5" /> Cartão de Cidadão
    </span>
  ) : (
    <span className="inline-flex items-center rounded-md bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">Assinatura simples</span>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[92vh] w-full overflow-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl ${wide ? "sm:max-w-2xl" : "sm:max-w-md"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn-ghost -mr-2 px-2 py-1" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function Alert({ kind = "error", children }: { kind?: "error" | "info" | "success" | "warning"; children: ReactNode }) {
  const style = {
    error: "border-red-200 bg-red-50 text-red-800",
    info: "border-sky-200 bg-sky-50 text-sky-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
  }[kind];
  return <div className={`rounded-lg border px-3.5 py-2.5 text-sm whitespace-pre-line ${style}`}>{children}</div>;
}

let pushToast: ((t: { text: string; kind: "ok" | "error" }) => void) | null = null;
export function toast(text: string, kind: "ok" | "error" = "ok") {
  pushToast?.({ text, kind });
}
export function Toaster() {
  const [items, setItems] = useState<{ id: number; text: string; kind: "ok" | "error" }[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { id, ...t }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4500);
    };
    return () => {
      pushToast = null;
    };
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto max-w-md rounded-lg px-4 py-2.5 text-sm shadow-lg ${t.kind === "ok" ? "bg-navy-900 text-white" : "bg-red-700 text-white"}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
      <DocIcon className="mb-3 h-10 w-10 text-slate-300" />
      <h3 className="font-semibold text-slate-800">{title}</h3>
      {children && <p className="muted mt-1 max-w-sm">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// Ícones simples (traço)
type IP = { className?: string };
const S = (p: IP & { children: ReactNode }) => (
  <svg className={p.className ?? "h-5 w-5"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {p.children}
  </svg>
);
export const DocIcon = (p: IP) => <S {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></S>;
export const IdIcon = (p: IP) => <S {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="11" r="2" /><path d="M6.5 16c.6-1.4 1.6-2 2.5-2s1.9.6 2.5 2M14 10h4M14 13h3" /></S>;
export const PenIcon = (p: IP) => <S {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></S>;
export const TemplateIcon = (p: IP) => <S {...p}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h8M8 15h4" /><path d="M15 15l1.5 1.5L19 14" /></S>;
export const PlusIcon = (p: IP) => <S {...p}><path d="M12 5v14M5 12h14" /></S>;
export const FolderIcon = (p: IP) => <S {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></S>;
export const InboxIcon = (p: IP) => <S {...p}><path d="M4 13l2-8h12l2 8v6H4z" /><path d="M4 13h5l1 2h4l1-2h5" /></S>;
export const SettingsIcon = (p: IP) => <S {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></S>;
export const TrashIcon = (p: IP) => <S {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></S>;
export const CheckIcon = (p: IP) => <S {...p}><path d="M5 12l5 5L20 7" /></S>;
export const DownloadIcon = (p: IP) => <S {...p}><path d="M12 4v12M7 11l5 5 5-5M5 20h14" /></S>;
export const UploadIcon = (p: IP) => <S {...p}><path d="M12 20V8M7 13l5-5 5 5M5 4h14" /></S>;
export const ArrowUp = (p: IP) => <S {...p}><path d="M12 19V5M6 11l6-6 6 6" /></S>;
export const ArrowDown = (p: IP) => <S {...p}><path d="M12 5v14M6 13l6 6 6-6" /></S>;
export const LogoutIcon = (p: IP) => <S {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" /></S>;
export const MenuIcon = (p: IP) => <S {...p}><path d="M4 7h16M4 12h16M4 17h16" /></S>;
export const ShieldIcon = (p: IP) => <S {...p}><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></S>;

export function Logo({ light }: { light?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
        <rect width="32" height="32" rx="7" fill={light ? "#ffffff" : "#0f2445"} />
        <path d="M8 20c3-1 4.5-7 7-7s1 6 3.5 6S22 14 24 13" fill="none" stroke={light ? "#0f2445" : "#fff"} strokeWidth="2.2" strokeLinecap="round" />
        <path d="M8 24h16" stroke="#38bdf8" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span className={`text-lg font-semibold tracking-tight ${light ? "text-white" : "text-navy-900"}`}>Signed</span>
    </div>
  );
}
