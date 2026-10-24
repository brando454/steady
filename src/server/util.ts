export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export function cleanText(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== "string") {
    if (!required && (value == null || value === "")) return "";
    throw new HttpError(400, `${field} is missing`);
  }
  const text = value.trim();
  if (!text && required) throw new HttpError(400, `${field} is missing`);
  if (text.length > max) throw new HttpError(400, `${field} is too long`);
  return text;
}

export function readNumber(value: unknown, field: string, max = 20_000): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number < 0 || number > max) throw new HttpError(400, `${field} looks off`);
  return Math.round(number * 10) / 10;
}

export function optionalNumber(value: unknown, field: string, max = 20_000): number | null {
  if (value == null || value === "") return null;
  return readNumber(value, field, max);
}

export function readDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, "Pick a date");
  return value;
}

export function readTime(value: unknown): string {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) throw new HttpError(400, "Pick a time");
  return value;
}

export function cleanThumb(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !value.startsWith("data:image/jpeg;base64,")) {
    throw new HttpError(400, "Photo should be a jpeg thumbnail");
  }
  if (value.length > 120_000) throw new HttpError(400, "Photo thumbnail is too large");
  const payload = value.slice("data:image/jpeg;base64,".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new HttpError(400, "Photo thumbnail is invalid");
  return value;
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://***");
}
