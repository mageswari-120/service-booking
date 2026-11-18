import type { ActionFunctionArgs } from "@remix-run/node";

import { lookupShopName, sendBookingConfirmation } from "../lib/bookings/confirmation.server";
import { createBookingsFromOrder } from "../lib/bookings/create.server";
import type { OrderPayload } from "../lib/bookings/order";
import { authenticate } from "../shopify.server";

/**
 * orders/create → one Booking per booked line item, then the customer's
 * "Your Upcoming Booking" email.
 *
 * Returns 200 once the bookings are saved, even if an email fails, so Shopify
 * doesn't retry the whole order for a mail problem. Retries that do arrive are
 * harmless: bookings are unique per line item, and each email is claimed via
 * confirmationSentAt before it is sent. A failed email can be resent from the
 * admin Bookings page.
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

  const shopName = await lookupShopName(shop, admin);
  for (const { booking } of toEmail) {
    await sendBookingConfirmation(booking.id, { shopName });
  }

  return new Response();
};
