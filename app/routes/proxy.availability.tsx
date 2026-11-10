import type { LoaderFunctionArgs } from "@remix-run/node";
import { DateTime } from "luxon";

import { buildSlotParams, loadBookableService } from "../lib/booking/context.server";
import { NOT_BOOKABLE, proxyJson, proxyShop } from "../lib/booking/proxy.server";
import { bookableDays } from "../lib/slots/engine";

/**
 * GET /apps/booking/availability?variant=<id>&month=YYYY-MM
 *
 * Which days of a month have at least one open slot. The widget's first call:
 * a 404 `{ bookable: false }` tells it this variant isn't a service, and it
 * stays hidden.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = await proxyShop(request);
  const url = new URL(request.url);
  const variant = url.searchParams.get("variant") ?? "";
  const service = shop ? await loadBookableService(shop, variant) : null;
  if (!service) return proxyJson(NOT_BOOKABLE, 404);

  const zone = service.geometry.timezone;
  const now = new Date();
  const nowLocal = DateTime.fromJSDate(now, { zone });
  const lastLocal = nowLocal.plus({ days: service.geometry.maxAdvanceDays });

  const requested = DateTime.fromFormat(url.searchParams.get("month") ?? "", "yyyy-MM", {
    zone,
  });
  const month = requested.isValid ? requested : nowLocal.startOf("month");

  // Only scan the part of the month that can hold slots at all.
  const from = DateTime.max(month.startOf("month"), nowLocal);
  const to = DateTime.min(month.endOf("month"), lastLocal);

  const days =
    from < to
      ? bookableDays(
          await buildSlotParams(service, from.toJSDate(), to.toJSDate(), now),
        )
      : [];

  return proxyJson({
    bookable: true,
    title: service.title,
    timezone: zone,
    month: month.toFormat("yyyy-MM"),
    // Bounds for the widget's prev/next buttons.
    firstMonth: nowLocal.toFormat("yyyy-MM"),
    lastMonth: lastLocal.toFormat("yyyy-MM"),
    days,
  });
};
