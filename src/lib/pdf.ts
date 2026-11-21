import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDoc = pdfjs.PDFDocumentProxy;

export async function openPdf(src: string | ArrayBuffer | Uint8Array): Promise<PdfDoc> {
  const params = typeof src === "string" ? { url: src } : { data: src instanceof Uint8Array ? src : new Uint8Array(src) };
  return pdfjs.getDocument({ ...params, isEvalSupported: false }).promise;
}

/** Dimensões das páginas tal como são mostradas (pontos, com rotação). */
export async function pageSizes(doc: PdfDoc): Promise<{ w: number; h: number }[]> {
  const out: { w: number; h: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const v = p.getViewport({ scale: 1 });
    out.push({ w: v.width, h: v.height });
  }
  return out;
}
