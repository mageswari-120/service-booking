import type { ActionFunctionArgs } from "@remix-run/node";

import db from "../db.server";
import { authenticate } from "../shopify.server";

/**
 * customers/data_request — mandatory compliance topic.
 *
 * The merchant is the data controller; Shopify notifies us so we can hand them
 * whatever we hold about that customer. The merchant then has 30 days to pass
 * it on. We assemble the record and log it as structured JSON so it is
 * retrievable from the application logs.
 *
 * Returning 200 is all Shopify requires, but a 200 with no data gathered is how
 * apps fail this at audit, so the payload is built for real.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const body = payload as {
    customer?: { id?: number | string; email?: string };
    orders_requested?: Array<number | string>;
  };

  const orderIds = (body.orders_requested ?? []).map(String);
  const email = body.customer?.email ?? undefined;

  const filters = [
    ...(orderIds.length ? [{ shopifyOrderId: { in: orderIds } }] : []),
    ...(email ? [{ customerEmail: email }] : []),
  ];

  const bookings = filters.length
    ? await db.booking.findMany({
        where: { shop: { domain: shop }, OR: filters },
        select: {
          id: true,
          shopifyOrderId: true,
          shopifyOrderName: true,
          startsAt: true,
          endsAt: true,
          status: true,
          customerName: true,
          customerEmail: true,
          customerPhone: true,
          intakeAnswers: true,
          createdAt: true,
          service: { select: { title: true } },
        },
      })
    : [];

  // One structured line so it can be grepped out of the logs and handed over.
  console.log(
    JSON.stringify({
      event: "customers/data_request",
      shop,
      customerId: body.customer?.id ?? null,
      customerEmail: email ?? null,
      ordersRequested: orderIds,
      bookingCount: bookings.length,
      bookings,
    }),
  );

  console.log(`[${topic}] ${shop}: assembled ${bookings.length} booking(s)`);

  return new Response();
};
