import type { LoaderFunctionArgs } from "@remix-run/node";
import { DateTime } from "luxon";

import { loadBookableServices, seatRules } from "../lib/booking/context.server";
import { monthSlotsMany, viewZone, type MonthSlot } from "../lib/booking/month.server";
import { NOT_BOOKABLE, proxyJson, proxyShop } from "../lib/booking/proxy.server";

/**
 * GET /apps/booking/calendar?month=YYYY-MM[&product=<id>][&tz=<IANA zone>]
 *
 * The "Booking calendar" block's month view: every active service of the shop
 * (or only the given product's), each with its slots per day. Services are
 * sent once and referenced by index from `days`, so a busy month stays small.
 *
 * Day keys are in the visitor's timezone (`tz`), else each service's own, as
 * in /availability. A day
 * whose slots are all taken is still listed (every `remaining` 0) so the
 * calendar can show it as sold out. 404 `{ bookable: false }` when the shop
 * (or product) has no bookable services.
 *
 * All services' slots come from one set of reads (monthSlotsMany): four
 * queries per request whatever the number of services.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const started = performance.now();
  const shop = await proxyShop(request);
  const url = new URL(request.url);
  const services = shop
    ? await loadBookableServices(shop, url.searchParams.get("product") || null)
    : [];
  if (!services.length) return proxyJson(NOT_BOOKABLE, 404);

  const now = new Date();
  const tz = url.searchParams.get("tz");
  const requested = url.searchParams.get("month");
  const month = /^\d{4}-\d{2}$/.test(requested ?? "")
    ? (requested as string)
    : DateTime.fromJSDate(now, { zone: viewZone(services[0].service, tz) }).toFormat("yyyy-MM");

  const slotsStarted = performance.now();
  const months = await monthSlotsMany(
    services.map((s) => s.service),
    month,
    now,
    tz,
  );
  const slotsMs = performance.now() - slotsStarted;

  const days: Record<string, { s: number; slots: MonthSlot[] }[]> = {};
  months.forEach((m, s) => {
    Object.keys(m.slots).forEach((day) => {
      (days[day] ??= []).push({ s, slots: m.slots[day] });
    });
  });

  const response = proxyJson({
    bookable: true,
    month,
    // Prev/next bounds: as far as any one service can be booked.
    firstMonth: months.map((m) => m.firstMonth).sort()[0],
    lastMonth: months.map((m) => m.lastMonth).sort().pop(),
    services: services.map(({ variantId, service }) => ({
      variant: variantId,
      title: service.title,
      timezone: service.geometry.timezone,
      duration: service.geometry.durationMinutes,
      capacity: service.geometry.capacityPerSlot,
      ...seatRules(service),
      questions: service.questions,
      signature: service.requireSignature,
    })),
    days,
  });
  // Diagnostics, visible in the browser's Network tab.
  response.headers.set(
    "Server-Timing",
    `slots;dur=${slotsMs.toFixed(1)}, total;dur=${(performance.now() - started).toFixed(1)}`,
  );
  return response;
};
