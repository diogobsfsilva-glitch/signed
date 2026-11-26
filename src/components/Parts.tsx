// Índice dos documentos de um pacote (página de assinatura e detalhe do documento).
import type { ReactNode } from "react";
import { useT } from "../lib/signer-i18n";
import type { DocPart } from "../../supabase/functions/_shared/types";
import { partRanges } from "../../supabase/functions/_shared/types";

export function PartsIndex({ parts, action, className = "" }: { parts: DocPart[] | null | undefined; action?: (i: number) => ReactNode; className?: string }) {
  const { t } = useT();
  if (!parts || parts.length < 2) return null;
  return (
    <nav className={`rounded-lg border border-slate-200 bg-white p-3 ${className}`} aria-label={t("pkg_intro", { n: parts.length })}>
      <p className="text-sm font-medium text-slate-900">{t("pkg_intro", { n: parts.length })}</p>
      <ol className="mt-1.5 space-y-0.5 text-sm">
        {partRanges(parts).map((p, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="w-5 shrink-0 text-right text-xs text-slate-500 tabular-nums">{i + 1}.</span>
            <a href={`#parte-${i + 1}`} className="min-w-0 flex-1 truncate text-navy-800 hover:underline">{p.name}</a>
            <span className="shrink-0 text-xs text-slate-500">{p.from === p.to ? t("pkg_page", { from: p.from }) : t("pkg_pages", { from: p.from, to: p.to })}</span>
            {action?.(i)}
          </li>
        ))}
      </ol>
    </nav>
  );
}
