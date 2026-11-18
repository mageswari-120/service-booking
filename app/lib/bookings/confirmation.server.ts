import db from "../../db.server";
import { parseAnswers } from "../booking/details";
import { renderBookingConfirmation } from "../email/booking-confirmation";
import { sendEmail } from "../email/send.server";
import { resolveTimezone } from "../shop.server";

const SHOP_NAME_QUERY = `#graphql
  query ServiceBookingShopName { shop { name } }
`;

type GraphqlClient = { graphql: (query: string) => Promise<Response> } | null | undefined;

/** The store's display name, falling back to the myshopify handle. */
export async function lookupShopName(shopDomain: string, admin: GraphqlClient): Promise<string> {
  const fallback = shopDomain.replace(/\.myshopify\.com$/, "");
  if (!admin) return fallback;
  try {
    const res = await admin.graphql(SHOP_NAME_QUERY);
    const body = (await res.json()) as { data?: { shop?: { name?: string } } };
    return body.data?.shop?.name || fallback;
  } catch (error) {
    console.error(`[bookings] shop name lookup failed for ${shopDomain}`, error);
    return fallback;
  }
}

export type ConfirmationResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "not-eligible" | "already-sent" | "send-failed"; error?: string };

/**
 * Send the customer's "Your Upcoming Booking" email for one booking.
 *
 * Claims the booking via confirmationSentAt before sending, so concurrent
 * webhook retries can't send twice; releases the claim if the send fails so
 * the merchant can resend it from the Bookings page.
 *
 * `force` (manual resend from the admin) sends even if one was sent before.
 */
export async function sendBookingConfirmation(
  bookingId: string,
  opts: { shopName: string; force?: boolean },
): Promise<ConfirmationResult> {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    include: {
      service: { select: { title: true, timezone: true } },
      shop: { select: { timezone: true, contactEmail: true } },
    },
  });
  if (!booking) return { ok: false, reason: "not-found" };
  if (booking.status !== "CONFIRMED" || !booking.customerEmail) return { ok: false, reason: "not-eligible" };

  const previous = booking.confirmationSentAt;
  const claimed = await db.booking.updateMany({
    where: opts.force ? { id: booking.id } : { id: booking.id, confirmationSentAt: null },
    data: { confirmationSentAt: new Date() },
  });
  if (!claimed.count) return { ok: false, reason: "already-sent" };

  const email = renderBookingConfirmation({
    shopName: opts.shopName,
    serviceTitle: booking.service.title,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    timezone: resolveTimezone(booking.service.timezone, booking.shop.timezone),
    seats: booking.seats,
    orderName: booking.shopifyOrderName,
    bookingId: booking.id,
    customerName: booking.customerName,
    answers: parseAnswers(booking.intakeAnswers),
    signed: !!booking.signaturePng,
  });
  const sent = await sendEmail({
    to: booking.customerEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: booking.shop.contactEmail,
  });
  if (!sent.ok) {
    console.error(`[bookings] confirmation email for ${booking.id} not sent: ${sent.error}`);
    await db.booking.update({ where: { id: booking.id }, data: { confirmationSentAt: previous } });
    return { ok: false, reason: "send-failed", error: sent.error };
  }
  return { ok: true };
}
