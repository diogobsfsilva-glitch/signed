// Converte um .docx carregado num rascunho em original.pdf (via Microsoft 365).

import { handler, HttpError, json, readJson } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";
import { BUCKET, docFolder, download, serviceClient, upload } from "../_shared/engine.ts";
import { convertDocxToPdf, m365Config } from "../_shared/m365.ts";
import { assertValidPdf } from "../_shared/pdf.ts";

Deno.serve(handler(async (req) => {
  const sb = serviceClient();
  const user = await requireUser(sb, req);
  const { document_id } = await readJson<{ document_id: string }>(req);
  const { data: doc } = await sb.from("documents").select("id, owner_id, workspace_id, status, title").eq("id", document_id).single();
  if (!doc || doc.owner_id !== user.id) throw new HttpError(404, "Documento não encontrado.");
  if (doc.status !== "draft") throw new HttpError(409, "O documento já foi enviado.");
  const cfg = m365Config();
  if (!cfg?.siteId) {
    throw new HttpError(501, "A conversão de Word ainda não está configurada. Guarde o documento como PDF no Word (Ficheiro > Guardar como > PDF) e carregue o PDF.", "not_configured");
  }
  const src = `${docFolder(doc)}/upload.docx`;
  const docx = await download(sb, src);
  const pdf = await convertDocxToPdf(cfg, docx, `${doc.title}.docx`);
  const pages = await assertValidPdf(pdf);
  const dest = `${docFolder(doc)}/original.pdf`;
  await upload(sb, dest, pdf);
  await sb.storage.from(BUCKET).remove([src]);
  await sb.from("documents").update({ original_path: dest, page_count: pages }).eq("id", doc.id);
  return json({ ok: true, path: dest, pages });
}));
