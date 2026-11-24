// Pacotes de documentos: converter ficheiros em PDF, juntar e reorganizar partes (no browser, com pdf-lib).
import { PDFDocument } from "pdf-lib";
import { supabase, BUCKET } from "./supabase";
import { convertDocx } from "./api";
import type { DocPart } from "../../supabase/functions/_shared/types";
import { partRanges } from "../../supabase/functions/_shared/types";

export const MAX_FILE = 25 * 1024 * 1024;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function fileKind(f: File): "pdf" | "docx" | null {
  const n = f.name.toLowerCase();
  if (f.type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".docx")) return "docx";
  return null;
}

export function baseName(f: File | string): string {
  const n = typeof f === "string" ? f : f.name;
  return n.replace(/\.(pdf|docx)$/i, "").replace(/[_-]+/g, " ").trim().slice(0, 150) || "Documento";
}

async function loadPdf(bytes: Uint8Array, name: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    throw new Error(`Não foi possível abrir "${name}". Está protegido com palavra-passe ou danificado?`);
  }
}

/** PDF de um ficheiro: o próprio PDF, ou o Word convertido no servidor (part.pdf, apagado a seguir). */
export async function fileToPdf(docId: string, base: string, file: File): Promise<Uint8Array> {
  if (fileKind(file) === "pdf") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await loadPdf(bytes, file.name);
    return bytes;
  }
  const up = await supabase.storage.from(BUCKET).upload(`${base}/upload.docx`, file, { contentType: DOCX, upsert: true });
  if (up.error) throw up.error;
  await convertDocx(docId, true);
  const dl = await supabase.storage.from(BUCKET).download(`${base}/part.pdf`);
  if (dl.error) throw dl.error;
  await supabase.storage.from(BUCKET).remove([`${base}/part.pdf`]);
  return new Uint8Array(await dl.data.arrayBuffer());
}

export type PartSource = { name: string } & ({ kind: "old"; index: number } | { kind: "new"; bytes: Uint8Array });

/**
 * Monta um PDF novo a partir de partes existentes (por índice) e de ficheiros novos.
 * Devolve o PDF, as partes e a correspondência página antiga → página nova (páginas removidas não aparecem).
 */
export async function buildPackage(
  current: Uint8Array | null,
  currentParts: DocPart[],
  sources: PartSource[],
): Promise<{ bytes: Uint8Array; parts: DocPart[]; pageMap: Map<number, number> }> {
  const out = await PDFDocument.create();
  const old = current ? await loadPdf(current, "documento atual") : null;
  const ranges = partRanges(currentParts);
  const parts: DocPart[] = [];
  const pageMap = new Map<number, number>();
  for (const s of sources) {
    let src: PDFDocument;
    let idx: number[];
    if (s.kind === "old") {
      if (!old) throw new Error("Documento atual em falta.");
      const r = ranges[s.index];
      src = old;
      idx = Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from - 1 + i);
    } else {
      src = await loadPdf(s.bytes, s.name);
      idx = src.getPageIndices();
    }
    if (!idx.length) throw new Error(`"${s.name}" não tem páginas.`);
    const start = out.getPageCount();
    for (const p of await out.copyPages(src, idx)) out.addPage(p);
    if (s.kind === "old") idx.forEach((oldIdx, k) => pageMap.set(oldIdx + 1, start + k + 1));
    parts.push({ name: s.name.trim().slice(0, 150) || "Documento", pages: idx.length });
  }
  const bytes = await out.save();
  if (bytes.length > MAX_FILE) throw new Error("O pacote tem mais de 25 MB. Retire documentos ou reduza o tamanho dos ficheiros.");
  return { bytes, parts, pageMap };
}
