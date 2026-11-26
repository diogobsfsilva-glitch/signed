import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/signer-i18n";
import "@fontsource/dancing-script/600.css";
import { Modal } from "./ui";

type Tab = "draw" | "type" | "upload";

/** Recorta o espaço em branco e devolve PNG (data URL). */
function trimCanvas(src: HTMLCanvasElement): string | null {
  const ctx = src.getContext("2d")!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 8;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")!.drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

const INK = "#0f2445";

export function SignaturePad({
  open,
  onClose,
  onDone,
  kind,
  defaultName,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (png: string) => void;
  kind: "signature" | "initials";
  defaultName: string;
}) {
  const [tab, setTab] = useState<Tab>("draw");
  const [typed, setTyped] = useState("");
  const [empty, setEmpty] = useState(true);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const initials = defaultName
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0]?.toUpperCase())
      .join("");
    setTyped(kind === "initials" ? initials : defaultName);
    setEmpty(true);
    setUploaded(null);
  }, [open, kind, defaultName]);

  // Prepara o canvas ao abrir o separador "Desenhar" e sempre que muda de tamanho (ex.: rodar o telemóvel).
  // Mudar o tamanho apaga o desenho, por isso o botão "Usar" volta a ficar desativado.
  useEffect(() => {
    if (!open || tab !== "draw") return;
    const c = canvas.current;
    if (!c) return;
    let w = 0;
    const setup = () => {
      const r = c.getBoundingClientRect();
      if (Math.round(r.width) === w) return;
      w = Math.round(r.width);
      const dpr = window.devicePixelRatio || 1;
      c.width = r.width * dpr;
      c.height = r.height * dpr;
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2.4;
      setEmpty(true);
    };
    setup();
    const ro = new ResizeObserver(setup);
    ro.observe(c);
    return () => ro.disconnect();
  }, [open, tab]);

  function pos(e: React.PointerEvent) {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  async function typedPng(): Promise<string | null> {
    const text = typed.trim();
    if (!text) return null;
    await document.fonts.load('600 96px "Dancing Script"').catch(() => {});
    const c = document.createElement("canvas");
    const size = 96;
    const ctx = c.getContext("2d")!;
    ctx.font = `600 ${size}px "Dancing Script"`;
    const w = Math.ceil(ctx.measureText(text).width) + 40;
    c.width = w;
    c.height = size * 1.6;
    const ctx2 = c.getContext("2d")!;
    ctx2.font = `600 ${size}px "Dancing Script"`;
    ctx2.fillStyle = INK;
    ctx2.textBaseline = "middle";
    ctx2.fillText(text, 20, c.height / 2);
    return trimCanvas(c);
  }

  async function onFile(f: File) {
    if (!/^image\/(png|jpeg)$/.test(f.type)) return;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      return;
    }
    const scale = Math.min(1, 800 / img.width, 300 / img.height);
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    // Fundo branco -> transparente
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const lum = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3;
      if (lum > 225) d.data[i + 3] = 0;
    }
    ctx.putImageData(d, 0, 0);
    setUploaded(trimCanvas(c));
    URL.revokeObjectURL(url);
  }

  async function confirm() {
    let png: string | null = null;
    if (tab === "draw" && canvas.current) png = trimCanvas(canvas.current);
    if (tab === "type") png = await typedPng();
    if (tab === "upload") png = uploaded;
    if (png) onDone(png);
  }

  const { t } = useT();
  const title = kind === "initials" ? t("sp_initials") : t("sp_signature");
  const canConfirm = (tab === "draw" && !empty) || (tab === "type" && typed.trim()) || (tab === "upload" && uploaded);

  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      <div className="mb-3 inline-flex rounded-lg bg-slate-100 p-1 text-sm" role="tablist">
        {(
          [
            ["draw", t("sp_draw")],
            ["type", t("sp_type")],
            ["upload", t("sp_upload")],
          ] as [Tab, string][]
        ).map(([t, l]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`rounded-md px-3 py-1.5 font-medium ${tab === t ? "bg-white shadow-sm text-navy-900" : "text-slate-600"}`}
            onClick={() => setTab(t)}
          >
            {l}
          </button>
        ))}
      </div>

      {tab === "draw" && (
        <div>
          <canvas
            ref={canvas}
            className="h-48 w-full touch-none rounded-lg border-2 border-dashed border-slate-300 bg-white"
            onPointerDown={(e) => {
              drawing.current = true;
              last.current = pos(e);
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drawing.current || !last.current) return;
              const p = pos(e);
              const ctx = canvas.current!.getContext("2d")!;
              ctx.beginPath();
              ctx.moveTo(last.current.x, last.current.y);
              const mx = (last.current.x + p.x) / 2;
              const my = (last.current.y + p.y) / 2;
              ctx.quadraticCurveTo(last.current.x, last.current.y, mx, my);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
              last.current = p;
              setEmpty(false);
            }}
            onPointerUp={() => {
              drawing.current = false;
              last.current = null;
            }}
            onPointerCancel={() => {
              drawing.current = false;
              last.current = null;
            }}
          />
          <div className="mt-2 flex items-center justify-between">
            <p className="muted">{t("sp_draw_hint")}</p>
            <button
              className="btn-ghost"
              onClick={() => {
                const c = canvas.current!;
                c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
                setEmpty(true);
              }}
            >
              {t("sp_clear")}
            </button>
          </div>
        </div>
      )}

      {tab === "type" && (
        <div>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={60} aria-label={t("sp_name")} />
          <div className="mt-3 flex h-36 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white px-4">
            <span className="truncate font-script text-5xl text-navy-900">{typed || " "}</span>
          </div>
        </div>
      )}

      {tab === "upload" && (
        <div>
          <label className="flex h-36 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 text-sm text-slate-600 hover:bg-slate-100">
            {uploaded ? <img src={uploaded} alt={t("sp_signature")} className="max-h-28" /> : t("sp_upload_hint")}
            <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </label>
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>
          {t("cancel")}
        </button>
        <button className="btn-primary" disabled={!canConfirm} onClick={confirm}>
          {kind === "initials" ? t("sp_use_initials") : t("sp_use_signature")}
        </button>
      </div>
    </Modal>
  );
}
