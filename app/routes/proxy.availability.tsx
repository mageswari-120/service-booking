import type { LoaderFunctionArgs } from "@remix-run/node";

import { loadBookableService, seatRules } from "../lib/booking/context.server";
import { monthSlots } from "../lib/booking/month.server";
import { NOT_BOOKABLE, proxyJson, proxyShop } from "../lib/booking/proxy.server";

/**
 * GET /apps/booking/availability?variant=<id>&month=YYYY-MM
 *
 * Which days of a month have at least one open slot, plus those slots grouped
 * by day — computing the days already produces them, and shipping them lets
 * the widget show times without a /slots request per day. The widget's first
 * call: a 404 `{ bookable: false }` tells it this variant isn't a service.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const t0 = performance.now();
  const shop = await proxyShop(request);
  const tAuth = performance.now();
  const url = new URL(request.url);
  const variant = url.searchParams.get("variant") ?? "";
  const service = shop ? await loadBookableService(shop, variant) : null;
  if (!service) return proxyJson(NOT_BOOKABLE, 404);
  const tService = performance.now();

  // Booked-out slots come too (remaining 0), so the widget can show them
  // struck through; `days` lists only the days that can still be booked.
  const { month, firstMonth, lastMonth, days, slots } = await monthSlots(
    service,
    url.searchParams.get("month"),
  );
  const tEnd = performance.now();

  const response = proxyJson({
    bookable: true,
    title: service.title,
    timezone: service.geometry.timezone,
    month,
    // Bounds for the widget's prev/next buttons.
    firstMonth,
    lastMonth,
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
  // DevTools → Network → Timing: where the time went (auth = app proxy
  // signature + session, service / slots = database).
  response.headers.set(
    "Server-Timing",
    `auth;dur=${(tAuth - t0).toFixed(0)}, service;dur=${(tService - tAuth).toFixed(0)}, ` +
      `slots;dur=${(tEnd - tService).toFixed(0)}, total;dur=${(tEnd - t0).toFixed(0)}`,
  );
  return response;
};
