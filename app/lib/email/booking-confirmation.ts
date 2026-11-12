import { DateTime } from "luxon";

import type { IntakeAnswer } from "../booking/details";

/**
 * The customer's "Your Upcoming Booking" email. Pure (no DB, no network) so
 * it is unit-tested in booking-confirmation.test.ts. Inline CSS only: most
 * mail clients drop <style> blocks.
 */

export interface BookingConfirmationInput {
  shopName: string;
  serviceTitle: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  seats: number;
  orderName: string | null;
  bookingId: string;
  customerName: string | null;
  answers: IntakeAnswer[];
  signed: boolean;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function answerText(a: IntakeAnswer): string {
  if (typeof a.value === "boolean") return a.value ? "Yes" : "No";
  return a.value;
}

export function renderBookingConfirmation(input: BookingConfirmationInput): RenderedEmail {
  const start = DateTime.fromJSDate(input.startsAt, { zone: input.timezone });
  const end = DateTime.fromJSDate(input.endsAt, { zone: input.timezone });
  const minutes = Math.round(end.diff(start, "minutes").minutes);
  const time = (d: DateTime) => d.toFormat("h:mm a").toLowerCase();

  const what = `${input.serviceTitle} - ${minutes} minutes`;
  const date = start.toFormat("MMMM d, yyyy");
  const when = `${time(start)} - ${time(end)} (${input.timezone})`;
  const bookingRef = input.orderName ?? input.bookingId;
  const greeting = input.customerName ? `Hi ${input.customerName},` : "Hi,";
  const subject = `${input.serviceTitle}: Your Upcoming Booking`;

  const extra: [string, string][] = input.answers.map((a) => [a.label, answerText(a)]);
  if (input.signed) extra.push(["Signature", "Signed"]);

  const field = (label: string, value: string) =>
    `<p style="margin:0 0 4px;font-size:13px;color:#6b6b6b;font-weight:600">${escapeHtml(label)}</p>` +
    `<p style="margin:0 0 20px;font-size:16px;color:#1a1a1a;font-weight:600">${escapeHtml(value)}</p>`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f3f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f3f3;padding:24px 0">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff">
<tr><td style="padding:48px 40px 32px;text-align:center;border-bottom:1px solid #e6e6e6">
<div style="display:inline-block;width:60px;height:60px;line-height:60px;border-radius:50%;background:#d7efdf;color:#1d6b38;font-size:30px">&#10003;</div>
<h1 style="margin:24px 0 8px;font-size:24px;line-height:1.4;color:#1a1a1a">${escapeHtml(subject)}</h1>
<p style="margin:0;font-size:15px;color:#555">Here are the details of your upcoming appointment.</p>
</td></tr>
<tr><td style="padding:32px 40px 12px">
<p style="margin:0 0 20px;font-size:15px;color:#333">${escapeHtml(greeting)}</p>
${field("What", what)}
<p style="margin:0 0 4px;font-size:13px;color:#6b6b6b;font-weight:600">When</p>
<p style="margin:0 0 2px;font-size:16px;color:#1a1a1a;font-weight:600">${escapeHtml(date)}</p>
<p style="margin:0 0 20px;font-size:14px;color:#555">${escapeHtml(when)}</p>
${field("Attendees", String(input.seats))}
${field("Booking ID", bookingRef)}
</td></tr>
${
  extra.length
    ? `<tr><td style="padding:28px 40px 12px;border-top:1px solid #e6e6e6">
<h2 style="margin:0 0 20px;font-size:19px;color:#1a1a1a">Additional Information</h2>
${extra.map(([l, v]) => field(l, v)).join("\n")}
</td></tr>`
    : ""
}
<tr><td style="padding:20px 40px 32px;border-top:1px solid #e6e6e6;font-size:13px;color:#888;text-align:center">
${escapeHtml(input.shopName)} &middot; Reply to this email if you need to change your booking.
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    subject,
    "",
    greeting,
    "",
    `What: ${what}`,
    `When: ${date}, ${when}`,
    `Attendees: ${input.seats}`,
    `Booking ID: ${bookingRef}`,
    ...(extra.length ? ["", "Additional Information", ...extra.map(([l, v]) => `${l}: ${v}`)] : []),
    "",
    input.shopName,
  ].join("\n");

  return { subject, html, text };
}
