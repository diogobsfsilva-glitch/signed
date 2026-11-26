import type { ReactNode } from "react";
import type { FieldType } from "../../supabase/functions/_shared/types";
import { FIELD_LABELS, parseAttachment } from "../../supabase/functions/_shared/types";

/** Ícone de cada tipo de campo (desenhado, igual em todos os sistemas; os emojis mudavam de aspeto). */
const FIELD_PATHS: Record<FieldType, ReactNode> = {
  signature: <path d="M3 17c3-1 4.5-7 7-7 2 0 1 5 3 5s2.5-3 4-3 1.5 2 4 2M3 21h18" />,
  initials: <path d="M4 18l3.5-10L11 18M5.3 14.5h4.4M14 8h3.5a2.5 2.5 0 0 1 0 5H14zm0 5h4a2.5 2.5 0 0 1 0 5h-4z" />,
  text: <path d="M5 6h14M12 6v13M9 19h6" />,
  date: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></>,
  checkbox: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 12l3 3 5-6" /></>,
  radio: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" fill="currentColor" /></>,
  dropdown: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M14 11l2 2 2-2" /></>,
  name: <><circle cx="12" cy="8" r="4" /><path d="M5 20c1-4 4-6 7-6s6 2 7 6" /></>,
  email: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M4 7l8 6 8-6" /></>,
  signed_date: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4M9 15l2 2 4-4" /></>,
  attachment: <path d="M20 11l-8 8a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7" />,
};

export function FieldIcon({ type, className = "h-4 w-4" }: { type: FieldType; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {FIELD_PATHS[type]}
    </svg>
  );
}

/** Mostra o valor de um campo já preenchido (só leitura). */
export function FieldValue({ type, value, options, height }: { type: FieldType; value: string | null; options?: string[] | null; height: number }) {
  if (!value && type !== "radio") return null;
  const fs = Math.max(8, Math.min(16, height * 0.6));
  switch (type) {
    case "signature":
    case "initials":
      return value?.startsWith("data:image") ? <img src={value} alt={FIELD_LABELS[type]} className="h-full w-full object-contain" /> : null;
    case "checkbox":
      return value === "true" ? <span className="flex h-full w-full items-center justify-center font-bold" style={{ fontSize: fs }}>✓</span> : null;
    case "attachment": {
      const a = parseAttachment(value);
      return a ? <span className="truncate px-1" style={{ fontSize: fs }}>📎 {a.name}</span> : null;
    }
    case "date":
    case "signed_date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
      return <span className="truncate px-1" style={{ fontSize: fs }}>{m ? `${m[3]}/${m[2]}/${m[1]}` : value}</span>;
    }
    case "radio":
      return (
        <div className="flex h-full flex-col justify-around px-1">
          {(options ?? []).map((o) => (
            <div key={o} className="flex items-center gap-1 truncate" style={{ fontSize: Math.max(8, Math.min(13, height / (options?.length || 1) * 0.6)) }}>
              <span>{o === value ? "◉" : "○"}</span> {o}
            </div>
          ))}
        </div>
      );
    default:
      return <span className="truncate px-1" style={{ fontSize: fs }}>{value}</span>;
  }
}

/** Tamanho por omissão (pontos PDF) de cada tipo de campo. */
export const DEFAULT_SIZE: Record<FieldType, { w: number; h: number }> = {
  signature: { w: 170, h: 48 },
  initials: { w: 64, h: 36 },
  text: { w: 160, h: 22 },
  date: { w: 96, h: 22 },
  checkbox: { w: 16, h: 16 },
  radio: { w: 140, h: 44 },
  dropdown: { w: 140, h: 22 },
  name: { w: 160, h: 22 },
  email: { w: 180, h: 22 },
  signed_date: { w: 96, h: 22 },
  attachment: { w: 150, h: 26 },
};
