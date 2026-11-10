import type { LoaderFunctionArgs } from "@remix-run/node";
import { DateTime } from "luxon";

import { buildSlotParams, loadBookableService } from "../lib/booking/context.server";
import { NOT_BOOKABLE, proxyJson, proxyShop } from "../lib/booking/proxy.server";
import { computeSlots } from "../lib/slots/engine";

/**
 * GET /apps/booking/slots?variant=<id>&date=YYYY-MM-DD
 *
 * Open slots on one local day of the service's timezone. Times go out as UTC
 * ISO strings plus the zone; the widget formats them, so the customer always
 * sees the business's local time, wherever they are browsing from.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = await proxyShop(request);
  const url = new URL(request.url);
  const service = shop
    ? await loadBookableService(shop, url.searchParams.get("variant") ?? "")
    : null;
  if (!service) return proxyJson(NOT_BOOKABLE, 404);

  const zone = service.geometry.timezone;
  const day = DateTime.fromFormat(url.searchParams.get("date") ?? "", "yyyy-MM-dd", {
    zone,
  });
  if (!day.isValid) return proxyJson({ error: "Invalid date" }, 400);

  const params = await buildSlotParams(
    service,
    day.startOf("day").toJSDate(),
    day.plus({ days: 1 }).startOf("day").toJSDate(),
    new Date(),
  );

  return proxyJson({
    timezone: zone,
    date: day.toFormat("yyyy-MM-dd"),
    // Lets the widget show "3 / 5 available" for group services.
    capacity: service.geometry.capacityPerSlot,
    slots: computeSlots(params).map((s) => ({
      start: s.startsAt.toISOString(),
      end: s.endsAt.toISOString(),
      remaining: s.remaining,
    })),
  });
};
