/**
 * Transactional email through Resend (https://resend.com, free tier 3,000
 * emails/month). Plain fetch, no SDK.
 *
 * RESEND_API_KEY — from resend.com → API Keys. Unset: emails are skipped (logged).
 * EMAIL_FROM     — e.g. "Bookings <bookings@yourdomain.com>". Until a domain is
 *                  verified in Resend, use "Bookings <onboarding@resend.dev>",
 *                  which can only deliver to the Resend account's own address.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
}

export type SendResult = { ok: true; id: string | null } | { ok: false; skipped?: boolean; error: string };

const TEST_SENDER_HINT =
  "EMAIL_FROM uses Resend's test sender (@resend.dev), which only delivers to the Resend " +
  "account owner's own address. Verify a domain at resend.com/domains and set " +
  'EMAIL_FROM="Bookings <bookings@your-verified-domain>" (in .env and on the host).';

let warnedTestSender = false;

export async function sendEmail(email: OutgoingEmail): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY not set; skipped "${email.subject}" to ${email.to}`);
    return { ok: false, skipped: true, error: "RESEND_API_KEY not set" };
  }
  const from = process.env.EMAIL_FROM || "Bookings <onboarding@resend.dev>";
  const testSender = /@resend\.dev>?\s*$/i.test(from);
  if (testSender && !warnedTestSender) {
    warnedTestSender = true;
    console.warn(`[email] ${TEST_SENDER_HINT}`);
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) {
      const error = `Resend ${res.status}: ${body.message ?? "unknown error"}`;
      return { ok: false, error: res.status === 403 && testSender ? `${error} — ${TEST_SENDER_HINT}` : error };
    }
    return { ok: true, id: body.id ?? null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
