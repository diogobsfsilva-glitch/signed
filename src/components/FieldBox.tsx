import type { FieldType } from "../../supabase/functions/_shared/types";
import { FIELD_LABELS } from "../../supabase/functions/_shared/types";

export function fieldIcon(type: FieldType): string {
  return { signature: "✍", initials: "AB", text: "T", date: "📅", checkbox: "☑", radio: "◉", dropdown: "▾" }[type];
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
    case "date": {
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
};
