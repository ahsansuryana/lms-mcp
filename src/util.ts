// ---------- WIB ----------
// LMS menyimpan tanggal sebagai string naif ("2026-09-23 14:00:00" / "2026-09-23T14:00")
// yang dimaksudkan WIB (UTC+7, tanpa DST). Jangan pakai new Date(string).
const WIB_OFFSET_HOURS = 7;

export function parseWIB(value: unknown): Date | null {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h - WIB_OFFSET_HOURS, +mi, +(s || 0)));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function fmtWIB(value: unknown): string {
  const d = value instanceof Date ? value : parseWIB(value);
  if (!d) return "-";
  const s = d.toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${s} WIB`;
}

/** "2 hari 3 jam" / "45 menit"; ms negatif → "lewat 2 hari". */
export function fmtDelta(ms: number): string {
  const past = ms < 0;
  let min = Math.round(Math.abs(ms) / 60000);
  const days = Math.floor(min / 1440);
  min -= days * 1440;
  const hours = Math.floor(min / 60);
  min -= hours * 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} hari`);
  if (hours) parts.push(`${hours} jam`);
  if (!days && (min || !hours)) parts.push(`${min} menit`);
  const text = parts.join(" ");
  return past ? `lewat ${text}` : `${text} lagi`;
}

// ---------- HTML → teks ----------
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

export function htmlToText(html: unknown, maxLen = 4000): string {
  if (html == null) return "";
  let t = String(html)
    .replace(/<\s*(script|style)[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length > maxLen) t = t.slice(0, maxLen).trimEnd() + `… [dipotong, total ${t.length} karakter]`;
  return t;
}

// ---------- Envelope ----------
export interface Page<T = any> {
  items: T[];
  pagination: any | null;
}

/** Normalisasi pola respons list: {data:[]}, {data:{data:[]}}, dst. */
export function unwrapList<T = any>(json: any): Page<T> {
  if (Array.isArray(json)) return { items: json, pagination: null };
  if (Array.isArray(json?.data)) return { items: json.data, pagination: json.pagination ?? null };
  if (Array.isArray(json?.data?.data)) return { items: json.data.data, pagination: json.data.pagination ?? null };
  return { items: [], pagination: null };
}

export function errMessage(json: any, fallback: string): string {
  const m = json?.message;
  if (typeof m === "string" && m) return m;
  if (m && typeof m === "object") return JSON.stringify(m);
  return fallback;
}
