// CSV para o envio em massa: leitura tolerante ao Excel português (";", BOM, aspas, CRLF)
// e conversão das colunas em valores de campos.
import type { FieldType } from "../../supabase/functions/_shared/types";

/** Lê um CSV e devolve as linhas (a primeira é o cabeçalho). Deteta ";", "," ou tabulação. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delim = [";", ",", "\t"].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") {
      quoted = true;
    } else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ""));
}

/** Escreve um CSV com ";" (abre bem no Excel em português). */
export function toCsv(rows: string[][]): string {
  const esc = (v: string) => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return "\uFEFF" + rows.map((r) => r.map(esc).join(";")).join("\r\n") + "\r\n";
}

/** Normaliza um nome de coluna/campo para comparação (sem acentos, minúsculas, espaços simples). */
export function normalizeKey(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const NAME_KEYS = ["nome", "nome completo", "name"];
const EMAIL_KEYS = ["email", "e mail", "correio eletronico"];
const CIVIL_KEYS = ["nic", "n identificacao civil", "numero de identificacao civil", "identificacao civil", "cc"];
const LANG_KEYS = ["idioma", "lingua", "language", "lang"];

/** "EN", "inglês", "English"… -> "en". null se não for reconhecido. */
export function parseLanguage(v: string): "pt" | "en" | "es" | "fr" | null {
  const k = normalizeKey(v);
  if (!k) return null;
  if (["pt", "portugues", "portuguese", "portugal"].includes(k)) return "pt";
  if (["en", "ingles", "english", "uk", "gb"].includes(k)) return "en";
  if (["es", "espanhol", "espanol", "spanish", "castellano"].includes(k)) return "es";
  if (["fr", "frances", "francais", "french"].includes(k)) return "fr";
  return null;
}

export interface CsvColumns {
  name: number;
  email: number;
  civilId: number;
  language: number;
  /** índice da coluna -> rótulo normalizado do campo */
  fields: Map<number, string>;
  /** colunas que não correspondem a nada (aviso) */
  unknown: string[];
}

/** Identifica as colunas do cabeçalho: nome, email, nº de identificação civil e campos pelo rótulo. */
export function mapColumns(header: string[], fieldLabels: string[]): CsvColumns {
  const labels = new Set(fieldLabels.map(normalizeKey));
  const cols: CsvColumns = { name: -1, email: -1, civilId: -1, language: -1, fields: new Map(), unknown: [] };
  header.forEach((h, i) => {
    const k = normalizeKey(h);
    if (cols.name < 0 && NAME_KEYS.includes(k)) cols.name = i;
    else if (cols.email < 0 && EMAIL_KEYS.includes(k)) cols.email = i;
    else if (cols.civilId < 0 && CIVIL_KEYS.includes(k)) cols.civilId = i;
    else if (cols.language < 0 && LANG_KEYS.includes(k)) cols.language = i;
    else if (labels.has(k)) cols.fields.set(i, k);
    else if (k) cols.unknown.push(h);
  });
  return cols;
}

/**
 * Converte o texto de uma célula no valor guardado pelo campo.
 * Devolve { value } ou { error } (mensagem para o utilizador).
 */
export function cellToValue(type: FieldType, raw: string, options: string[] | null): { value: string | null; error?: string } {
  const v = raw.trim();
  if (!v) return { value: null };
  switch (type) {
    case "date": {
      let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
      if (m) {
        const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
        return isNaN(Date.parse(iso)) ? { value: null, error: `data inválida «${v}»` } : { value: iso };
      }
      m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      return m && !isNaN(Date.parse(v)) ? { value: v } : { value: null, error: `data inválida «${v}» (use dd/mm/aaaa)` };
    }
    case "checkbox": {
      const k = normalizeKey(v);
      if (["sim", "s", "x", "true", "1", "yes", "verdadeiro"].includes(k)) return { value: "true" };
      if (["nao", "n", "false", "0", "no", "falso"].includes(k)) return { value: "false" };
      return { value: null, error: `use «sim» ou «não» em vez de «${v}»` };
    }
    case "radio":
    case "dropdown": {
      const found = (options ?? []).find((o) => normalizeKey(o) === normalizeKey(v));
      return found ? { value: found } : { value: null, error: `«${v}» não é uma das opções (${(options ?? []).join(", ")})` };
    }
    default:
      return v.length > 500 ? { value: null, error: "texto com mais de 500 caracteres" } : { value: v };
  }
}
