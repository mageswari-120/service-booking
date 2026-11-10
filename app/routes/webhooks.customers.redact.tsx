import type { ActionFunctionArgs } from "@remix-run/node";
import { Prisma } from "@prisma/client";

import db from "../db.server";
import { authenticate } from "../shopify.server";

/**
 * customers/redact — mandatory compliance topic.
 *
 * Shopify sends this when a customer asks the merchant to erase their data, 48
 * hours after the request. We strip the personal fields from the affected
 * bookings but keep the rows: the merchant still needs the slot history, and
 * `startsAt` plus the order id are not personal data on their own.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const body = payload as {
    customer?: { id?: number | string; email?: string };
    orders_to_redact?: Array<number | string>;
  };

  const orderIds = (body.orders_to_redact ?? []).map(String);
  const email = body.customer?.email ?? undefined;

  // Match on the orders Shopify named, and on the stored email as a fallback —
  // a booking made before an order existed (a $0 draft-order booking) would
  // otherwise be missed.
  const where = {
    shop: { domain: shop },
    OR: [
      ...(orderIds.length ? [{ shopifyOrderId: { in: orderIds } }] : []),
      ...(email ? [{ customerEmail: email }] : []),
    ],
  };

  if (where.OR.length === 0) {
    console.log(`[${topic}] ${shop}: nothing identified to redact`);
    return new Response();
  }

  const { count } = await db.booking.updateMany({
    where,
    data: {
      customerName: null,
      customerEmail: null,
      customerPhone: null,
      // Intake answers are free text and routinely hold personal details.
      // A Json column needs DbNull for SQL NULL; plain `null` is a type error.
      intakeAnswers: Prisma.DbNull,
    },
  });

  console.log(`[${topic}] ${shop}: redacted ${count} booking(s)`);

  return new Response();
};
