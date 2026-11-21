// Regras do fluxo de assinatura (puras, testáveis).

import type { DocPhase, FieldRow, RecipientRow, SignatureMode } from "./types.ts";
import { isFillField } from "./types.ts";

type R = Pick<RecipientRow, "id" | "role" | "signing_order" | "status">;
type F = Pick<FieldRow, "recipient_id" | "type">;

export interface WorkflowDoc {
  signature_mode: SignatureMode;
  phase: DocPhase;
  sequential: boolean;
}

/** Signatários que ainda têm de agir na fase atual. */
function pendingInPhase<T extends R>(doc: WorkflowDoc, recipients: T[], fields: F[]): T[] {
  const signers = recipients.filter((r) => r.role === "signer");
  if (doc.signature_mode === "simple") {
    return signers.filter((r) => r.status !== "signed");
  }
  if (doc.phase === "fill") {
    return signers.filter(
      (r) =>
        !["filled", "signed"].includes(r.status) &&
        fields.some((f) => f.recipient_id === r.id && isFillField(f.type, "qualified")),
    );
  }
  return signers.filter((r) => r.status !== "signed");
}

/**
 * Quem pode agir agora. Em modo sequencial só o(s) de menor ordem ainda pendente;
 * em paralelo, todos os pendentes. Na fase de assinatura CC é sempre sequencial,
 * porque cada assinatura qualificada é acrescentada à anterior.
 */
export function currentRecipients<T extends R>(doc: WorkflowDoc, recipients: T[], fields: F[]): T[] {
  const pending = pendingInPhase(doc, recipients, fields);
  if (pending.length === 0) return [];
  const qualifiedSign = doc.signature_mode === "qualified" && doc.phase === "sign";
  if (!doc.sequential && !qualifiedSign) return pending;
  const minOrder = Math.min(...pending.map((r) => r.signing_order));
  const first = pending.filter((r) => r.signing_order === minOrder);
  // Na assinatura CC, mesmo com ordens iguais, um de cada vez (ordem estável).
  return qualifiedSign ? [first.sort((a, b) => a.id.localeCompare(b.id))[0]] : first;
}

/** A fase de preenchimento (modo CC) já terminou? */
export function fillPhaseDone(doc: WorkflowDoc, recipients: R[], fields: F[]): boolean {
  return pendingInPhase({ ...doc, phase: "fill" }, recipients, fields).length === 0;
}

export function allSigned(recipients: R[]): boolean {
  const signers = recipients.filter((r) => r.role === "signer");
  return signers.length > 0 && signers.every((r) => r.status === "signed");
}

export interface ValidationIssue {
  message: string;
}

/** Validações antes de enviar. */
export function validateForSend(
  doc: WorkflowDoc & { original_path: string | null; is_template?: boolean },
  recipients: (R & { name: string; email: string })[],
  fields: (F & { id: string; options: string[] | null })[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (doc.is_template) issues.push({ message: "Um modelo não pode ser enviado. Use-o para criar um documento." });
  if (!doc.original_path) issues.push({ message: "Falta carregar o documento PDF." });
  const signers = recipients.filter((r) => r.role === "signer");
  if (signers.length === 0) issues.push({ message: "Adicione pelo menos um signatário." });
  const emails = new Set<string>();
  for (const r of recipients) {
    const e = r.email.trim().toLowerCase();
    if (!e) {
      issues.push({ message: `Falta o email de ${r.name}.` });
      continue;
    }
    if (emails.has(e)) issues.push({ message: `O email ${r.email} aparece repetido.` });
    emails.add(e);
  }
  for (const s of signers) {
    const own = fields.filter((f) => f.recipient_id === s.id);
    if (!own.some((f) => f.type === "signature")) {
      issues.push({ message: `${s.name} não tem nenhum campo de assinatura.` });
    }
  }
  for (const f of fields) {
    const r = recipients.find((x) => x.id === f.recipient_id);
    if (!r) issues.push({ message: "Há campos atribuídos a um destinatário que já não existe." });
    else if (r.role !== "signer") issues.push({ message: `${r.name} recebe só cópia e não pode ter campos.` });
    if ((f.type === "dropdown" || f.type === "radio") && (!f.options || f.options.filter(Boolean).length < 2)) {
      issues.push({ message: "Listas e opções únicas precisam de pelo menos duas opções." });
    }
    if (doc.signature_mode === "qualified" && f.type === "initials") {
      issues.push({ message: "No modo Cartão de Cidadão não há campos de iniciais (a assinatura qualificada é única)." });
    }
  }
  return dedupe(issues);
}

function dedupe(list: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return list.filter((i) => (seen.has(i.message) ? false : (seen.add(i.message), true)));
}

/** Valida os valores submetidos por um signatário para os seus campos. */
export function validateFieldValues(
  fields: Pick<FieldRow, "id" | "type" | "required" | "options" | "label">[],
  values: Record<string, string | null | undefined>,
): string[] {
  const errors: string[] = [];
  for (const f of fields) {
    const v = values[f.id];
    const empty = v === undefined || v === null || v === "" || (f.type === "checkbox" && v !== "true");
    const name = f.label || f.type;
    if (f.required && empty) {
      errors.push(`Preencha o campo obrigatório "${name}".`);
      continue;
    }
    if (empty) continue;
    switch (f.type) {
      case "signature":
      case "initials":
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v!) || v!.length > 700_000) {
          errors.push(`A assinatura "${name}" é inválida.`);
        }
        break;
      case "date":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v!) || isNaN(Date.parse(v!))) errors.push(`Data inválida em "${name}".`);
        break;
      case "checkbox":
        if (v !== "true" && v !== "false") errors.push(`Valor inválido em "${name}".`);
        break;
      case "radio":
      case "dropdown":
        if (!f.options?.includes(v!)) errors.push(`Opção inválida em "${name}".`);
        break;
      case "text":
        if (v!.length > 500) errors.push(`Texto demasiado longo em "${name}".`);
        break;
    }
  }
  return errors;
}
