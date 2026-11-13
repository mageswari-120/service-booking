import type { LoaderFunctionArgs } from "@remix-run/node";
import { DateTime } from "luxon";

import {
  buildSlotParams,
  loadBookableService,
  seatRules,
} from "../lib/booking/context.server";
import { NOT_BOOKABLE, proxyJson, proxyShop } from "../lib/booking/proxy.server";
import { slotsByDay } from "../lib/slots/engine";

/**
 * GET /apps/booking/availability?variant=<id>&month=YYYY-MM
 *
 * Which days of a month have at least one open slot, plus those slots grouped
 * by day — computing the days already produces them, and shipping them lets
 * the widget show times without a /slots request per day. The widget's first
 * call: a 404 `{ bookable: false }` tells it this variant isn't a service.
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

  // Booked-out slots come too (remaining 0), so the widget can show them
  // struck through; `days` lists only the days that can still be booked.
  const byDay =
    from < to
      ? slotsByDay({
          ...(await buildSlotParams(service, from.toJSDate(), to.toJSDate(), now)),
          includeFull: true,
        })
      : {};
  const days = Object.keys(byDay)
    .filter((day) => byDay[day].some((s) => s.remaining > 0))
    .sort();
  // `end` is left out: the widget only needs the start, and a month of short
  // slots adds up.
  // Every day the engine produced, not just `days`: a day whose slots are all
  // taken is absent from `days` (it can't be booked) but the storefront still
  // needs its slots to tell "sold out" apart from "never open".
  const slots = Object.fromEntries(
    Object.keys(byDay).map((day) => [
      day,
      byDay[day].map((s) => ({
        start: s.startsAt.toISOString(),
        capacity: s.capacity,
        remaining: s.remaining,
      })),
    ]),
  );

  return proxyJson({
    bookable: true,
    title: service.title,
    timezone: zone,
    month: month.toFormat("yyyy-MM"),
    // Bounds for the widget's prev/next buttons.
    firstMonth: nowLocal.toFormat("yyyy-MM"),
    lastMonth: lastLocal.toFormat("yyyy-MM"),
    days,
    // Default limit; each slot carries its own `capacity` too.
    capacity: service.geometry.capacityPerSlot,
    ...seatRules(service),
    slots,
    // The popup's second step: time range, questions, signature.
    duration: service.geometry.durationMinutes,
    questions: service.questions,
    signature: service.requireSignature,
  });
};
