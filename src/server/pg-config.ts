export function connectionConfig(raw: string): {
  connectionString: string;
  ssl?: { rejectUnauthorized: false };
} {
  const url = new URL(raw);
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  const host = url.hostname;
  const wantSsl =
    sslmode === "require" ||
    sslmode === "verify-ca" ||
    sslmode === "verify-full" ||
    host === "render.com" ||
    host.endsWith(".render.com");
  return {
    connectionString: url.toString(),
    ssl: wantSsl ? { rejectUnauthorized: false } : undefined,
  };
}
