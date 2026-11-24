import { useEffect, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { useT } from "../lib/signer-i18n";
import type { DocPart } from "../../supabase/functions/_shared/types";
import { partRanges } from "../../supabase/functions/_shared/types";
import { openPdf, type PdfDoc } from "../lib/pdf";
import { Alert, Spinner } from "./ui";

interface Props {
  src: string | ArrayBuffer | null;
  /** Conteúdo sobreposto a cada página (posicionado em %). */
  overlay?: (page: number, size: { width: number; height: number }) => ReactNode;
  onPageClick?: (page: number, x: number, y: number, e: MouseEvent) => void;
  onLoaded?: (doc: PdfDoc) => void;
  cursor?: string;
  /** Pacote: mostra o nome de cada documento antes da sua primeira página. */
  parts?: DocPart[] | null;
}

/** Mostra todas as páginas de um PDF à largura do contentor. */
export function PdfPages({ src, overlay, onPageClick, onLoaded, cursor, parts }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const { t } = useT();
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ranges = parts && parts.length > 1 ? partRanges(parts) : [];

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    setError(null);
    setDoc(null);
    openPdf(src)
      .then(async (d) => {
        const s: { w: number; h: number }[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const v = (await d.getPage(i)).getViewport({ scale: 1 });
          s.push({ w: v.width, h: v.height });
        }
        if (cancelled) return;
        setSizes(s);
        setDoc(d);
        onLoaded?.(d);
      })
      .catch(() => !cancelled && setError(t("pdf_error")));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrap} className="w-full">
      {error && <Alert>{error}</Alert>}
      {!doc && !error && (
        <div className="flex h-96 items-center justify-center">
          <Spinner className="h-7 w-7" />
        </div>
      )}
      {doc && width > 0 && (
        <div className="flex flex-col gap-4">
          {sizes.map((s, i) => {
            const h = Math.round((width * s.h) / s.w);
            const starts = ranges.findIndex((r) => r.from === i + 1);
            return (
              <div key={i} className="relative">
                {starts >= 0 && (
                  <div id={`parte-${starts + 1}`} className="mb-2 flex scroll-mt-20 items-baseline gap-2 border-b border-slate-300 pb-1.5">
                    <span className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{t("pkg_doc", { i: starts + 1, n: ranges.length })}</span>
                    <span className="truncate font-semibold text-slate-900">{ranges[starts].name}</span>
                  </div>
                )}
                <div
                  className="relative overflow-hidden rounded-sm bg-white shadow-[0_1px_3px_rgba(15,36,69,0.12),0_8px_24px_-12px_rgba(15,36,69,0.25)]"
                  style={{ width, height: h, cursor }}
                  data-page={i + 1}
                  onClick={(e) => {
                    if (!onPageClick) return;
                    const r = e.currentTarget.getBoundingClientRect();
                    onPageClick(i + 1, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e);
                  }}
                >
                  <PageCanvas doc={doc} page={i + 1} width={width} height={h} />
                  {overlay && <div className="absolute inset-0">{overlay(i + 1, { width, height: h })}</div>}
                </div>
                <div className="mt-1 text-center text-xs text-slate-400">
                  {t("page_of", { i: i + 1, n: sizes.length })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PageCanvas({ doc, page, width, height }: { doc: PdfDoc; page: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(page <= 2);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    let cancelled = false;
    (async () => {
      const p = await doc.getPage(page);
      if (cancelled || !ref.current) return;
      const base = p.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = p.getViewport({ scale: (width / base.width) * dpr });
      const canvas = ref.current;
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext("2d")!;
      task = p.render({ canvasContext: ctx, viewport: vp });
      await task.promise.catch(() => {});
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, width, visible]);

  return <canvas ref={ref} style={{ width, height }} className="block select-none" aria-label={`Página ${page}`} />;
}
