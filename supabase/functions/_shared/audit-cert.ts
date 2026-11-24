// Certificado de conclusão: resumo legível do processo e do registo de auditoria.

import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { AuditEventRow, RecipientRow, SignatureMode } from "./types.ts";
import { EVENT_LABELS, RECIPIENT_STATUS_LABELS } from "./types.ts";
import { formatLisbon } from "./util.ts";
import { winAnsiSafe } from "./pdf.ts";

export interface AuditCertificateInput {
  orgName: string;
  document: {
    id: string;
    title: string;
    signature_mode: SignatureMode;
    sent_at: string | null;
    completed_at: string | null;
    original_sha256: string | null;
    final_sha256: string | null;
    final_label: string;
  };
  owner: { name: string; email: string };
  recipients: (Pick<
    RecipientRow,
    "id" | "name" | "email" | "role" | "signing_order" | "status" | "signed_at" | "sign_ip" | "cert_subject" | "cert_issuer" | "cert_serial" | "decline_reason"
  > & { in_person?: boolean; group_emails?: string[] | null; signed_by?: string | null })[];
  events: Pick<AuditEventRow, "event" | "created_at" | "recipient_id" | "ip" | "hash">[];
  chainIntact: boolean;
  /** Anexos carregados pelos signatários. */
  attachments?: { recipient: string; name: string; size: number; sha256: string }[];
  /** Pacote: documentos incluídos, com as páginas e o hash da cópia separada. */
  parts?: { name: string; from: number; to: number; sha256: string | null }[];
  /** As cópias separadas têm o selo do Signed (assinatura simples) ou são só cópias (modo CC). */
  partsSigned?: boolean;
}

const A4 = { w: 595.28, h: 841.89 };
const M = 48;
const NAVY = rgb(0.06, 0.13, 0.27);
const GREY = rgb(0.38, 0.42, 0.48);
const LINE = rgb(0.85, 0.87, 0.9);

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont, private footer: string) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.y = A4.h - M;
    this.page.drawText(winAnsiSafe(this.font, this.footer), { x: M, y: 24, size: 7, font: this.font, color: GREY });
  }
  ensure(h: number) {
    if (this.y - h < M) this.newPage();
  }
  text(t: string, o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; maxW?: number } = {}) {
    const size = o.size ?? 9;
    const font = o.bold ? this.bold : this.font;
    const maxW = o.maxW ?? A4.w - M * 2 - ((o.x ?? M) - M);
    for (const line of wrap(font, winAnsiSafe(font, t), size, maxW)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x: o.x ?? M, y: this.y - size, size, font, color: o.color ?? NAVY });
      this.y -= size + 4;
    }
  }
  kv(k: string, v: string) {
    const size = 9;
    const lines = wrap(this.font, winAnsiSafe(this.font, v), size, A4.w - M * 2 - 140);
    this.ensure((size + 4) * lines.length);
    this.page.drawText(winAnsiSafe(this.bold, k), { x: M, y: this.y - size, size, font: this.bold, color: GREY });
    for (const line of lines) {
      this.page.drawText(line, { x: M + 140, y: this.y - size, size, font: this.font, color: NAVY });
      this.y -= size + 4;
    }
  }
  gap(h = 8) {
    this.y -= h;
  }
  rule() {
    this.ensure(10);
    this.page.drawLine({ start: { x: M, y: this.y - 4 }, end: { x: A4.w - M, y: this.y - 4 }, thickness: 0.7, color: LINE });
    this.y -= 12;
  }
}

function wrap(font: PDFFont, text: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const cand = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(cand, size) <= maxW) {
        line = cand;
        continue;
      }
      if (line) out.push(line);
      // Palavras muito longas (hashes): partir à força.
      let w = word;
      while (font.widthOfTextAtSize(w, size) > maxW) {
        let n = w.length;
        while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > maxW) n--;
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

export async function buildAuditCertificate(input: AuditCertificateInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Certificado de conclusão — ${input.document.title}`);
  doc.setProducer("Signed");
  doc.setCreator("Signed — Altis Hotels");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold, `Signed · ${input.orgName} · Documento ${input.document.id}`);

  w.text("Certificado de conclusão", { size: 20, bold: true });
  w.text(input.document.title, { size: 12, color: GREY });
  w.gap(6);
  w.rule();

  const mode =
    input.document.signature_mode === "qualified"
      ? "Assinatura eletrónica qualificada com Cartão de Cidadão / Chave Móvel Digital (eIDAS, art. 25.º n.º 2)"
      : "Assinatura eletrónica simples, com verificação do email por código";
  w.kv("ID do documento", input.document.id);
  w.kv("Tipo de assinatura", mode);
  w.kv("Remetente", `${input.owner.name} <${input.owner.email}>`);
  w.kv("Enviado em", formatLisbon(input.document.sent_at));
  w.kv("Concluído em", formatLisbon(input.document.completed_at));
  w.kv("SHA-256 do original", input.document.original_sha256 ?? "—");
  w.kv(`SHA-256 ${input.document.final_label}`, input.document.final_sha256 ?? "—");
  w.kv("Registo de auditoria", input.chainIntact ? "Íntegro (cadeia de hashes verificada)" : "ATENÇÃO: a cadeia de hashes não confere");
  w.gap(6);

  if (input.parts?.length) {
    w.text(`Documentos do pacote (${input.parts.length})`, { size: 13, bold: true });
    w.rule();
    for (const [i, p] of input.parts.entries()) {
      w.text(`${i + 1}. ${p.name}`, { bold: true, size: 9.5 });
      w.kv("Páginas", p.from === p.to ? `${p.from}` : `${p.from} a ${p.to}`);
      if (p.sha256) w.kv("SHA-256 da cópia separada", p.sha256);
      w.gap(3);
    }
    w.text(
      input.partsSigned
        ? "Todos os documentos foram assinados em conjunto. As cópias separadas têm o selo do Signed e o mesmo valor do pacote completo."
        : "Todos os documentos foram assinados em conjunto. As assinaturas qualificadas estão no pacote completo; as cópias separadas são apenas para consulta.",
      { size: 8.5, color: GREY },
    );
    w.gap(8);
  }

  w.text("Destinatários", { size: 13, bold: true });
  w.rule();
  const sorted = [...input.recipients].sort((a, b) => a.signing_order - b.signing_order);
  for (const r of sorted) {
    w.text(r.email ? `${r.name} <${r.email}>` : r.name, { bold: true, size: 10 });
    if (r.in_person) w.kv("Assinatura", "Presencial, no dispositivo de um colaborador (ver histórico)");
    if (r.group_emails?.length) w.kv("Grupo", r.group_emails.join(", "));
    if (r.signed_by) w.kv("Assinado por", r.signed_by);
    w.kv("Papel", r.role === "signer" ? `Signatário (ordem ${r.signing_order})` : "Recebe cópia");
    if (r.role === "signer") w.kv("Estado", RECIPIENT_STATUS_LABELS[r.status]);
    if (r.signed_at) w.kv("Assinou em", formatLisbon(r.signed_at));
    if (r.sign_ip) w.kv("Endereço IP", r.sign_ip);
    if (r.cert_subject) w.kv("Certificado", r.cert_subject);
    if (r.cert_issuer) w.kv("Emitido por", r.cert_issuer);
    if (r.cert_serial) w.kv("Nº de série", r.cert_serial);
    if (r.decline_reason) w.kv("Motivo da rejeição", r.decline_reason);
    w.gap(6);
  }

  if (input.attachments?.length) {
    w.text("Anexos dos signatários", { size: 13, bold: true });
    w.rule();
    for (const a of input.attachments) {
      w.text(`${a.name} — ${a.recipient}`, { bold: true, size: 9.5 });
      w.kv("Tamanho", `${Math.max(1, Math.round(a.size / 1024))} KB`);
      w.kv("SHA-256", a.sha256);
      w.gap(4);
    }
    w.gap(4);
  }

  w.text("Histórico", { size: 13, bold: true });
  w.rule();
  const names = new Map(input.recipients.map((r) => [r.id, r.name]));
  for (const e of input.events) {
    const who = e.recipient_id ? ` — ${names.get(e.recipient_id) ?? ""}` : "";
    const ip = e.ip ? ` · IP ${e.ip}` : "";
    w.text(`${formatLisbon(e.created_at)}  ${EVENT_LABELS[e.event] ?? e.event}${who}${ip}`, { size: 8.5 });
  }
  w.gap(8);
  const head = input.events.at(-1)?.hash;
  if (head) w.text(`Hash do último evento: ${head}`, { size: 7.5, color: GREY });
  return await doc.save({ useObjectStreams: false });
}
