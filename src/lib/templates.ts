// Modelos: criar um documento a partir de um modelo, ou guardar um documento como modelo.
import { supabase, BUCKET } from "./supabase";

export interface RecipientOverride {
  /** id do destinatário no documento de origem */
  id: string;
  name?: string;
  email?: string;
  civil_id?: string | null;
}

/**
 * Copia definições, destinatários e campos (na base de dados) e depois o PDF (no Storage).
 * Se a cópia do PDF falhar, apaga o rascunho criado. Devolve o id do documento novo.
 */
export async function instantiate(opts: {
  sourceId: string;
  sourcePath: string;
  asTemplate: boolean;
  title?: string;
  workspaceId?: string;
  folderId?: string | null;
  recipients?: RecipientOverride[];
  /** Lote do envio em massa */
  batchId?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc("instantiate_document", {
    p_source: opts.sourceId,
    p_as_template: opts.asTemplate,
    p_title: opts.title ?? null,
    p_workspace: opts.workspaceId ?? null,
    p_folder: opts.folderId ?? null,
    p_recipients: opts.recipients ?? [],
    p_batch: opts.batchId ?? null,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as { new_document_id: string; new_original_path: string } | null;
  if (!row) throw new Error("Não foi possível criar o documento.");
  const copy = await supabase.storage.from(BUCKET).copy(opts.sourcePath, row.new_original_path);
  if (copy.error) {
    await supabase.rpc("delete_draft_document", { p_document_id: row.new_document_id });
    throw new Error(`Não foi possível copiar o PDF: ${copy.error.message}`);
  }
  return row.new_document_id;
}
