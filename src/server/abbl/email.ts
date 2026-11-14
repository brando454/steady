import { HttpError } from "../util";

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.ABBL_EMAIL_FROM?.trim());
}

/** Sends the code. The caller must not log the code or the message body. */
export async function sendSignInCode(to: string, code: string): Promise<void> {
  if (!emailConfigured()) throw new HttpError(503, "Email sign-in is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY?.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.ABBL_EMAIL_FROM?.trim(),
      to: [to],
      subject: "Your ABBL sign-in code",
      text: `Your ABBL sign-in code is ${code}. It expires in 10 minutes.`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("email failed");
}
