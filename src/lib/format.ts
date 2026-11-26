const dt = new Intl.DateTimeFormat("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Lisbon" });
const d = new Intl.DateTimeFormat("pt-PT", { dateStyle: "medium", timeZone: "Europe/Lisbon" });

export const fmtDateTime = (s?: string | null) => (s ? dt.format(new Date(s)) : "—");
export const fmtDate = (s?: string | null) => (s ? d.format(new Date(s)) : "—");

export function relative(s?: string | null): string {
  if (!s) return "—";
  const diff = (Date.now() - new Date(s).getTime()) / 1000;
  if (diff < 60) return "agora mesmo";
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`;
  if (diff < 2 * 86400) return "ontem";
  if (diff < 7 * 86400) return `há ${Math.floor(diff / 86400)} dias`;
  return fmtDate(s);
}

export const RECIPIENT_COLORS = ["#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed", "#0891b2", "#dc2626", "#4d7c0f"];

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: string }).message);
  return "Ocorreu um erro.";
}
