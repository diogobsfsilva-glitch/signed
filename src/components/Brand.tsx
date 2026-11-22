// Marca do hotel na página de assinatura e no formulário público.
import type { CSSProperties } from "react";
import { Logo } from "./ui";

export interface BrandInfo {
  name: string;
  color: string | null;
  logoUrl: string | null;
}

/** Variáveis CSS que trocam a cor principal (botões) pela cor do hotel. */
export function brandStyle(brand?: BrandInfo | null): CSSProperties | undefined {
  if (!brand?.color) return undefined;
  return { "--color-navy-900": brand.color, "--color-navy-800": brand.color } as CSSProperties;
}

/** Logótipo do hotel (ou nome), com o Signed discreto; sem marca, mostra o logótipo do Signed. */
export function BrandMark({ brand }: { brand?: BrandInfo | null }) {
  if (!brand) return <Logo />;
  return (
    <div className="flex min-w-0 items-center gap-3">
      {brand.logoUrl ? (
        <img src={brand.logoUrl} alt={brand.name} className="h-9 max-w-[180px] object-contain" />
      ) : (
        <span className="truncate text-lg font-semibold" style={{ color: brand.color ?? undefined }}>{brand.name}</span>
      )}
      <span className="hidden text-[11px] text-slate-400 sm:inline">via Signed</span>
    </div>
  );
}

/** Luminância relativa (0 escuro, 1 claro) para avisar quando o texto branco fica ilegível. */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
