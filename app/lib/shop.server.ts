import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import db from "../db.server";

const SHOP_QUERY = `#graphql
  query ServiceBookingShop {
    shop {
      ianaTimezone
      contactEmail
    }
  }
`;

/**
 * Fetch the Shop row for a domain, creating it on first sight.
 *
 * The IANA timezone is the one piece of shop state the slot engine cannot work
 * without, so it is read from the Admin API rather than guessed, and refreshed
 * on every call that passes an `admin` context — merchants do change it, and a
 * stale zone silently shifts every slot the storefront offers.
 */
export async function getOrCreateShop(
  domain: string,
  admin?: AdminApiContext,
): Promise<{ id: string; domain: string; timezone: string }> {
  let timezone: string | undefined;
  let contactEmail: string | undefined;

  if (admin) {
    try {
      const response = await admin.graphql(SHOP_QUERY);
      const body = (await response.json()) as {
        data?: { shop?: { ianaTimezone?: string; contactEmail?: string } };
      };
      timezone = body.data?.shop?.ianaTimezone ?? undefined;
      contactEmail = body.data?.shop?.contactEmail ?? undefined;
    } catch (error) {
      // A failed shop lookup must not block the request. An existing row keeps
      // its stored zone; a new row falls back to UTC and is corrected on the
      // next successful call.
      console.error(`[shop] timezone sync failed for ${domain}`, error);
    }
  }

  return db.shop.upsert({
    where: { domain },
    create: {
      domain,
      timezone: timezone ?? "UTC",
      contactEmail,
    },
    update: {
      ...(timezone ? { timezone } : {}),
      ...(contactEmail ? { contactEmail } : {}),
      uninstalledAt: null,
    },
    select: { id: true, domain: true, timezone: true },
  });
}

/** The zone slot arithmetic runs in: service override, else the shop's. */
export function resolveTimezone(
  serviceTimezone: string | null | undefined,
  shopTimezone: string,
): string {
  return serviceTimezone ?? shopTimezone;
}
