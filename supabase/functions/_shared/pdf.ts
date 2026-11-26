// Escrita dos valores dos campos no PDF ("achatar") e preparação para assinatura CC.

import { degrees, PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import { type FieldRow, parseAttachment, type RecipientRow, type SignatureMode } from "./types.ts";
import { formatDateValue, fromBase64 } from "./util.ts";

export interface PageGeom {
  cx: number;
  cy: number;
  W: number;
  H: number;
  rotation: number;
}

export interface Placement {
  /** Ponto PDF que corresponde ao canto inferior esquerdo da caixa, tal como é vista. */
  ox: number;
  oy: number;
  /** Rotação a aplicar ao desenhar (graus, sentido anti-horário). */
  rotate: number;
  /** Largura e altura da caixa (pontos) na orientação vista. */
  bw: number;
  bh: number;
}

export function pageGeom(page: PDFPage): PageGeom {
  const crop = page.getCropBox();
  const rotation = (((page.getRotation().angle % 360) + 360) % 360) as number;
  return { cx: crop.x, cy: crop.y, W: crop.width, H: crop.height, rotation };
}

/** Dimensões da página tal como é mostrada (com rotação). */
export function viewedSize(g: PageGeom): { w: number; h: number } {
  return g.rotation % 180 === 0 ? { w: g.W, h: g.H } : { w: g.H, h: g.W };
}

/** Converte um ponto (u, v) em pontos, medido do canto superior esquerdo da página vista, para coordenadas PDF. */
export function viewedToPdf(g: PageGeom, u: number, v: number): { x: number; y: number } {
  switch (g.rotation) {
    case 90:
      return { x: g.cx + v, y: g.cy + u };
    case 180:
      return { x: g.cx + g.W - u, y: g.cy + v };
    case 270:
      return { x: g.cx + g.W - v, y: g.cy + g.H - u };
    default:
      return { x: g.cx + u, y: g.cy + g.H - v };
  }
}

/** Posição de um campo (coordenadas relativas 0..1) na página. */
export function placeField(g: PageGeom, f: Pick<FieldRow, "x" | "y" | "w" | "h">): Placement {
  const { w: vw, h: vh } = viewedSize(g);
  const u0 = f.x * vw;
  const v0 = f.y * vh;
  const bw = f.w * vw;
  const bh = f.h * vh;
  const o = viewedToPdf(g, u0, v0 + bh);
  return { ox: o.x, oy: o.y, rotate: g.rotation, bw, bh };
}

/** Converte um deslocamento local (lx para a direita, ly para cima, na orientação vista) em coordenadas PDF. */
function local(p: Placement, lx: number, ly: number): { x: number; y: number } {
  const a = (p.rotate * Math.PI) / 180;
  const cos = Math.round(Math.cos(a));
  const sin = Math.round(Math.sin(a));
  return { x: p.ox + lx * cos - ly * sin, y: p.oy + lx * sin + ly * cos };
}

// ---------------------------------------------------------------------------
// Texto seguro para fontes padrão (WinAnsi)
// ---------------------------------------------------------------------------
const encodable = new Map<string, boolean>();
export function winAnsiSafe(font: PDFFont, text: string): string {
  let out = "";
  for (const ch of text.replace(/[\r\n\t]+/g, " ")) {
    let ok = encodable.get(ch);
    if (ok === undefined) {
      try {
        font.encodeText(ch);
        ok = true;
      } catch {
        ok = false;
      }
      encodable.set(ch, ok);
    }
    out += ok ? ch : "?";
  }
  return out;
}

function fitText(font: PDFFont, text: string, maxW: number, maxSize: number, minSize = 5): { text: string; size: number } {
  let size = maxSize;
  while (size > minSize && font.widthOfTextAtSize(text, size) > maxW) size -= 0.5;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -2) + "…";
  try {
    font.encodeText(t);
  } catch {
    t = t.replace(/…/g, "...");
  }
  return { text: t, size };
}

function drawTextIn(page: PDFPage, font: PDFFont, p: Placement, raw: string, opts: { color?: ReturnType<typeof rgb>; maxSize?: number } = {}) {
  const pad = Math.min(2, p.bw * 0.05);
  const maxSize = Math.min(opts.maxSize ?? 12, p.bh * 0.72);
  const { text, size } = fitText(font, winAnsiSafe(font, raw), p.bw - pad * 2, Math.max(maxSize, 5));
  // Linha de base centrada verticalmente.
  const baseline = (p.bh - size * 0.72) / 2;
  const at = local(p, pad, baseline);
  page.drawText(text, { x: at.x, y: at.y, size, font, color: opts.color ?? rgb(0.07, 0.1, 0.2), rotate: degrees(p.rotate) });
}

function drawCheck(page: PDFPage, p: Placement) {
  const s = Math.min(p.bw, p.bh);
  const off = { x: (p.bw - s) / 2, y: (p.bh - s) / 2 };
  const pts = [
    [0.2, 0.5],
    [0.42, 0.25],
    [0.82, 0.78],
  ].map(([a, b]) => local(p, off.x + a * s, off.y + b * s));
  const color = rgb(0.07, 0.1, 0.2);
  const thickness = Math.max(1, s * 0.1);
  page.drawLine({ start: pts[0], end: pts[1], thickness, color });
  page.drawLine({ start: pts[1], end: pts[2], thickness, color });
}

async function drawSignatureImage(doc: PDFDocument, page: PDFPage, p: Placement, dataUrl: string) {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const img = await doc.embedPng(fromBase64(b64));
  const scale = Math.min(p.bw / img.width, p.bh / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const at = local(p, (p.bw - w) / 2, (p.bh - h) / 2);
  page.drawImage(img, { x: at.x, y: at.y, width: w, height: h, rotate: degrees(p.rotate) });
}

function drawRadio(page: PDFPage, font: PDFFont, p: Placement, options: string[], selected: string | null) {
  const n = Math.max(options.length, 1);
  const row = p.bh / n;
  const r = Math.min(row * 0.3, 6);
  options.forEach((opt, i) => {
    const ly = p.bh - row * (i + 0.5);
    const c = local(p, r + 1, ly);
    page.drawCircle({ x: c.x, y: c.y, size: r, borderWidth: 0.8, borderColor: rgb(0.2, 0.2, 0.3) });
    if (opt === selected) page.drawCircle({ x: c.x, y: c.y, size: r * 0.55, color: rgb(0.07, 0.1, 0.2) });
    const o = local(p, r * 2 + 4, ly - row / 2);
    const sub: Placement = { ox: o.x, oy: o.y, rotate: p.rotate, bw: p.bw - r * 2 - 4, bh: row };
    drawTextIn(page, font, sub, opt, { maxSize: 10 });
  });
}

export interface FlattenOptions {
  mode: SignatureMode;
  /** Modo CC: desenha caixas a indicar onde colocar a assinatura qualificada. */
  qualifiedPlaceholders?: boolean;
  recipients?: Pick<RecipientRow, "id" | "name">[];
}

/** Escreve os valores dos campos no PDF e devolve um novo PDF. */
export async function flattenFields(
  pdfBytes: Uint8Array,
  fields: Pick<FieldRow, "id" | "recipient_id" | "type" | "page" | "x" | "y" | "w" | "h" | "value" | "options" | "label">[],
  opts: FlattenOptions,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  // Formulários AcroForm existentes ficam fixos para não poderem ser alterados depois.
  try {
    doc.getForm().flatten();
  } catch {
    /* PDF sem formulário */
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();

  for (const f of fields) {
    const page = pages[f.page - 1];
    if (!page) continue;
    const p = placeField(pageGeom(page), f);
    const v = f.value;
    switch (f.type) {
      case "signature":
      case "initials":
        if (opts.mode === "qualified") {
          if (opts.qualifiedPlaceholders && f.type === "signature") {
            const who = opts.recipients?.find((r) => r.id === f.recipient_id)?.name ?? "";
            const a = local(p, 0, 0);
            page.drawRectangle({
              x: a.x,
              y: a.y,
              width: p.bw,
              height: p.bh,
              rotate: degrees(p.rotate),
              borderColor: rgb(0.15, 0.35, 0.75),
              borderWidth: 0.8,
              borderDashArray: [3, 2],
              color: rgb(0.93, 0.95, 1),
              opacity: 0.6,
              borderOpacity: 1,
            });
            const t = local(p, 0, p.bh / 2);
            const top: Placement = { ox: t.x, oy: t.y, rotate: p.rotate, bw: p.bw, bh: p.bh / 2 };
            drawTextIn(page, fontBold, top, "Assinatura qualificada (Cartão de Cidadão)", { maxSize: 8, color: rgb(0.15, 0.35, 0.75) });
            drawTextIn(page, font, { ...p, bh: p.bh / 2 }, who, { maxSize: 8, color: rgb(0.15, 0.35, 0.75) });
          }
        } else if (v && v.startsWith("data:image/png;base64,")) {
          await drawSignatureImage(doc, page, p, v);
        }
        break;
      case "text":
      case "name":
      case "email":
        if (v) drawTextIn(page, font, p, v);
        break;
      case "date":
      case "signed_date":
        if (v) drawTextIn(page, font, p, formatDateValue(v));
        break;
      case "attachment": {
        const a = parseAttachment(v);
        if (a) drawTextIn(page, font, p, `Anexo: ${a.name}`, { maxSize: 9 });
        break;
      }
      case "dropdown":
        if (v) drawTextIn(page, font, p, v);
        break;
      case "checkbox":
        if (v === "true") drawCheck(page, p);
        break;
      case "radio":
        drawRadio(page, font, p, f.options ?? [], v);
        break;
    }
  }
  return await doc.save({ useObjectStreams: false });
}

/** Lê dimensões das páginas (como são mostradas) — usado em testes e validações. */
export async function readPages(pdfBytes: Uint8Array): Promise<{ count: number; pages: { w: number; h: number }[] }> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const pages = doc.getPages().map((p) => viewedSize(pageGeom(p)));
  return { count: pages.length, pages };
}

/** Confirma que os bytes são um PDF que se consegue abrir (e não está cifrado). */
export async function assertValidPdf(pdfBytes: Uint8Array): Promise<number> {
  const head = new TextDecoder().decode(pdfBytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw new Error("O ficheiro não é um PDF.");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  } catch (e) {
    if (String(e).toLowerCase().includes("encrypt")) {
      throw new Error("O PDF está protegido com palavra-passe. Retire a proteção e volte a carregar.");
    }
    throw new Error("Não foi possível ler o PDF (ficheiro danificado?).");
  }
  if (doc.getPageCount() < 1) throw new Error("O PDF não tem páginas.");
  return doc.getPageCount();
}

/** Copia um intervalo de páginas (1-based, inclusive) para um PDF novo (um documento de um pacote). */
export async function extractPages(pdfBytes: Uint8Array, from: number, to: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const out = await PDFDocument.create();
  const idx = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
  for (const p of await out.copyPages(src, idx)) out.addPage(p);
  return await out.save();
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Dimensão máxima de uma imagem de assinatura (px). */
export const MAX_SIGNATURE_PX = 3000;

/**
 * Confirma que uma assinatura é um PNG que o pdf-lib consegue usar, com dimensões razoáveis.
 * Sem isto, uma imagem corrompida só falharia na conclusão e o documento ficaria preso.
 */
export async function assertSignaturePng(dataUrl: string): Promise<void> {
  const bytes = fromBase64(dataUrl.replace(/^data:image\/png;base64,/, ""));
  if (bytes.length < 33 || PNG_MAGIC.some((b, i) => bytes[i] !== b)) throw new Error("not_png");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = view.getUint32(16);
  const h = view.getUint32(20);
  if (!w || !h || w > MAX_SIGNATURE_PX || h > MAX_SIGNATURE_PX) throw new Error("bad_size");
  await (await PDFDocument.create()).embedPng(bytes);
}
