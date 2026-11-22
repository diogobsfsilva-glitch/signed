// Tipos partilhados entre o frontend e as edge functions.

export type SignatureMode = "simple" | "qualified";
export type DocStatus = "draft" | "in_progress" | "completed" | "declined" | "expired" | "cancelled";
export type DocPhase = "fill" | "sign";
export type RecipientRole = "signer" | "cc";
export type RecipientStatus = "pending" | "notified" | "viewed" | "filled" | "signed" | "declined";
export type FieldType =
  | "signature" | "initials" | "text" | "date" | "checkbox" | "radio" | "dropdown"
  | "name" | "email" | "signed_date" | "attachment";

/** Preenchidos automaticamente com os dados do signatário no momento em que assina. */
export const AUTO_FIELD_TYPES: readonly FieldType[] = ["name", "email", "signed_date"];
/** Tipos que o remetente pode pré-preencher antes de enviar. */
export const PREFILLABLE_FIELD_TYPES: readonly FieldType[] = ["text", "date", "checkbox", "radio", "dropdown"];
export const isAutoField = (t: FieldType) => AUTO_FIELD_TYPES.includes(t);
export const isPrefillable = (t: FieldType) => PREFILLABLE_FIELD_TYPES.includes(t);

export interface DocumentRow {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  owner_id: string;
  title: string;
  /** Lote de envio em massa (ou null). */
  batch_id?: string | null;
  /** Modelo: fica sempre em rascunho e é copiado para documentos novos. */
  is_template: boolean;
  status: DocStatus;
  signature_mode: SignatureMode;
  phase: DocPhase;
  sequential: boolean;
  subject: string | null;
  message: string | null;
  expires_at: string | null;
  reminder_days: number;
  original_path: string | null;
  original_sha256: string | null;
  page_count: number | null;
  pages: PageInfo[] | null;
  prepared_path: string | null;
  prepared_sha256: string | null;
  current_path: string | null;
  current_sha256: string | null;
  final_path: string | null;
  final_sha256: string | null;
  audit_path: string | null;
  archive_url: string | null;
  archive_error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  completed_at: string | null;
}

export interface PageInfo {
  /** Largura e altura da página tal como é mostrada (pontos PDF, já com rotação). */
  w: number;
  h: number;
}

export interface RecipientRow {
  id: string;
  document_id: string;
  name: string;
  email: string;
  role: RecipientRole;
  signing_order: number;
  civil_id: string | null;
  color: string;
  status: RecipientStatus;
  /** Muda quando o destinatário é corrigido ou delega: o link anterior deixa de funcionar. */
  token_version?: number;
  /** Assina presencialmente no dispositivo de um colaborador (sem email nem código). */
  in_person?: boolean;
  notified_at: string | null;
  notified_phase: DocPhase | null;
  reminded_at: string | null;
  viewed_at: string | null;
  filled_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  sign_ip: string | null;
  sign_user_agent: string | null;
  cert_subject: string | null;
  cert_issuer: string | null;
  cert_serial: string | null;
  cert_serial_number_attr: string | null;
  created_at: string;
}

export interface FieldRow {
  id: string;
  document_id: string;
  recipient_id: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
  label: string | null;
  options: string[] | null;
  group_name: string | null;
  value: string | null;
  /** Pré-preenchido pelo remetente e fixo: o signatário vê mas não altera. */
  readonly?: boolean;
  filled_at: string | null;
}

/** Valor guardado num campo de anexo (JSON). */
export interface AttachmentValue {
  path: string;
  name: string;
  size: number;
  type: string;
  sha256: string;
}

export function parseAttachment(v: string | null | undefined): AttachmentValue | null {
  if (!v || !v.startsWith("{")) return null;
  try {
    const a = JSON.parse(v);
    return typeof a?.path === "string" && typeof a?.name === "string" ? a : null;
  } catch {
    return null;
  }
}

export interface AuditEventRow {
  id: number;
  document_id: string;
  recipient_id: string | null;
  actor_user_id: string | null;
  event: string;
  ip: string | null;
  user_agent: string | null;
  details: Record<string, unknown>;
  created_at: string;
  prev_hash: string;
  hash: string;
}

/**
 * Tipos que o signatário preenche na fase de preenchimento: no modo CC tudo exceto assinaturas;
 * os campos automáticos nunca são preenchidos pelo signatário.
 */
export function isFillField(type: FieldType, mode: SignatureMode): boolean {
  if (isAutoField(type)) return false;
  if (mode === "simple") return true;
  return type !== "signature" && type !== "initials";
}

/** O signatário tem de dar um valor a este campo (não é automático nem fixo pelo remetente)? */
export function isSignerInput(f: { type: FieldType; readonly?: boolean | null }, mode: SignatureMode): boolean {
  return !f.readonly && isFillField(f.type, mode);
}

/** Valor de um campo automático para um signatário, no momento dado (data em Lisboa). */
export function autoFieldValue(type: FieldType, r: { name: string; email: string }, now = new Date()): string | null {
  if (type === "name") return r.name;
  if (type === "email") return r.email;
  if (type === "signed_date") {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return p; // AAAA-MM-DD
  }
  return null;
}

export const FIELD_LABELS: Record<FieldType, string> = {
  signature: "Assinatura",
  initials: "Iniciais",
  text: "Texto",
  date: "Data",
  checkbox: "Caixa de seleção",
  radio: "Opção única",
  dropdown: "Lista",
  name: "Nome",
  email: "Email",
  signed_date: "Data de assinatura",
  attachment: "Anexo",
};

export const STATUS_LABELS: Record<DocStatus, string> = {
  draft: "Rascunho",
  in_progress: "Em curso",
  completed: "Concluído",
  declined: "Rejeitado",
  expired: "Expirado",
  cancelled: "Cancelado",
};

export const RECIPIENT_STATUS_LABELS: Record<RecipientStatus, string> = {
  pending: "A aguardar",
  notified: "Notificado",
  viewed: "Visto",
  filled: "Preenchido",
  signed: "Assinado",
  declined: "Rejeitou",
};

export const EVENT_LABELS: Record<string, string> = {
  "document.created": "Documento criado",
  "document.created_from_template": "Criado a partir de um modelo",
  "template.created_from_document": "Modelo criado a partir de um documento",
  "document.sent": "Documento enviado",
  "document.cancelled": "Documento cancelado",
  "document.prepared": "PDF preparado para assinatura qualificada",
  "document.completed": "Documento concluído",
  "document.declined": "Documento rejeitado",
  "document.expired": "Documento expirado",
  "document.archived": "Arquivado no SharePoint",
  "document.archive_failed": "Falha ao arquivar no SharePoint",
  "recipient.notified": "Convite enviado",
  "recipient.reminded": "Lembrete enviado",
  "recipient.otp_sent": "Código de acesso enviado",
  "recipient.otp_failed": "Código de acesso errado",
  "recipient.authenticated": "Acesso confirmado com código",
  "recipient.viewed": "Documento aberto",
  "recipient.filled": "Campos preenchidos",
  "recipient.signed": "Assinou (assinatura simples)",
  "recipient.cc_downloaded": "Descarregou o PDF para assinar com CC",
  "recipient.cc_rejected": "Assinatura CC recusada",
  "recipient.cc_signed": "Assinou com Cartão de Cidadão",
  "recipient.declined": "Rejeitou o documento",
  "recipient.delegated": "Delegou a assinatura",
  "recipient.attachment_added": "Carregou um anexo",
  "document.corrected": "Documento corrigido pelo remetente",
  "recipient.awaiting_in_person": "À espera da assinatura presencial",
  "recipient.in_person_started": "Assinatura presencial iniciada",
  "document.created_from_public_link": "Criado a partir de um link público",
  "recipient.public_access": "Acedeu pelo link público",
};
