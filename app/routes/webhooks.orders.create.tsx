import type { ActionFunctionArgs } from "@remix-run/node";

import db from "../db.server";
import { parseAnswers } from "../lib/booking/details";
import { createBookingsFromOrder } from "../lib/bookings/create.server";
import type { OrderPayload } from "../lib/bookings/order";
import { renderBookingConfirmation } from "../lib/email/booking-confirmation";
import { sendEmail } from "../lib/email/send.server";
import { authenticate } from "../shopify.server";

const SHOP_NAME_QUERY = `#graphql
  query ServiceBookingShopName { shop { name } }
`;

/**
 * orders/create → one Booking per booked line item, then the customer's
 * "Your Upcoming Booking" email.
 *
 * Returns 200 once the bookings are saved, even if an email fails, so Shopify
 * doesn't retry the whole order for a mail problem. Retries that do arrive are
 * harmless: bookings are unique per line item, and each email is claimed via
 * confirmationSentAt before it is sent.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const results = await createBookingsFromOrder(shop, payload as OrderPayload);
  if (!results.length) return new Response();

  const toEmail = results.filter(
    (r) => r.booking.status === "CONFIRMED" && r.booking.customerEmail && !r.booking.confirmationSentAt,
  );
  if (!toEmail.length) return new Response();

  let shopName = shop.replace(/\.myshopify\.com$/, "");
  if (admin) {
    try {
      const res = await admin.graphql(SHOP_NAME_QUERY);
      const body = (await res.json()) as { data?: { shop?: { name?: string } } };
      shopName = body.data?.shop?.name || shopName;
    } catch (error) {
      console.error(`[bookings] shop name lookup failed for ${shop}`, error);
    }
  }
  const shopRow = await db.shop.findUnique({ where: { domain: shop }, select: { contactEmail: true } });

  for (const { booking, serviceTitle, timezone } of toEmail) {
    // Claim first so a concurrent retry can't send the same email twice.
    const claimed = await db.booking.updateMany({
      where: { id: booking.id, confirmationSentAt: null },
      data: { confirmationSentAt: new Date() },
    });
    if (!claimed.count) continue;

    const email = renderBookingConfirmation({
      shopName,
      serviceTitle,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      timezone,
      seats: booking.seats,
      orderName: booking.shopifyOrderName,
      bookingId: booking.id,
      customerName: booking.customerName,
      answers: parseAnswers(booking.intakeAnswers),
      signed: !!booking.signaturePng,
    });
    const sent = await sendEmail({
      to: booking.customerEmail!,
      subject: email.subject,
      html: email.html,
      text: email.text,
      replyTo: shopRow?.contactEmail,
    });
    if (!sent.ok) {
      console.error(`[bookings] confirmation email for ${booking.id} not sent: ${sent.error}`);
      await db.booking.update({ where: { id: booking.id }, data: { confirmationSentAt: null } });
    }
  }

  return new Response();
};
