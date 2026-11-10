import type { ActionFunctionArgs } from "@remix-run/node";

import db from "../db.server";
import { authenticate } from "../shopify.server";

/**
 * shop/redact — mandatory compliance topic.
 *
 * Sent 48 hours after a shop uninstalls the app. Everything we hold for that
 * shop goes: the Shop row cascades to services, availability rules, blackouts,
 * holds and bookings (see prisma/schema.prisma), and sessions are keyed by
 * domain rather than by shop id so they are deleted separately.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  await db.$transaction([
    db.shop.deleteMany({ where: { domain: shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);

  console.log(`[${topic}] ${shop}: all shop data deleted`);

  return new Response();
};
