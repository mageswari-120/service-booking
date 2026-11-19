import type { LoaderFunctionArgs } from "@remix-run/node";

import {
  loadBookableService,
  loadBookableServices,
  loadComboServices,
  seatRules,
} from "../lib/booking/context.server";
import { monthComboSlots } from "../lib/booking/month.server";
import { NOT_BOOKABLE, proxyJson, proxyShop } from "../lib/booking/proxy.server";
import { chainMinutes } from "../lib/slots/engine";

/**
 * GET /apps/booking/availability?variant=<id>&month=YYYY-MM[&with=<id>,<id>]
 *
 * Which days of a month have at least one open slot, plus those slots grouped
 * by day — computing the days already produces them, and shipping them lets
 * the widget show times without a /slots request per day. The widget's first
 * call: a 404 `{ bookable: false }` tells it this variant isn't a service.
 *
 * `services` lists every active service of the shop, for the popup's
 * "Service" switcher. `with` (variant IDs of combinable services) returns
 * start times where the service and those run back to back, `duration`
 * then covering the whole chain. `staff` and
 * `staffMode` drive the popup's "Choose staff" step; each slot lists the
 * staff ids free for it.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const t0 = performance.now();
  const shop = await proxyShop(request);
  const tAuth = performance.now();
  const url = new URL(request.url);
  const variant = url.searchParams.get("variant") ?? "";
  const service = shop ? await loadBookableService(shop, variant) : null;
  if (!service) return proxyJson(NOT_BOOKABLE, 404);

  // `with` (services booked back to back after this one) is supported by the
  // API and the hold endpoint; the popup doesn't send it at the moment.
  const withIds = (url.searchParams.get("with") ?? "")
    .split(",")
    .filter((id) => /^\d+$/.test(id))
    .slice(0, 5);
  // Unknown or no-longer-combinable IDs are dropped, not an error.
  const chain = withIds.length ? await loadComboServices(service, withIds) : [];
  const tService = performance.now();

  // Booked-out slots come too (remaining 0), so the widget can show them
  // struck through; `days` lists only the days that can still be booked.
  // The shop's services (the popup's "Service" switcher) load alongside.
  const [{ month, firstMonth, lastMonth, days, slots }, all] = await Promise.all([
    monthComboSlots(service, chain, url.searchParams.get("month")),
    loadBookableServices(shop!),
  ]);
  const tEnd = performance.now();

  // Staff the customer can choose from: for a chain, those who do every
  // staffed service in it.
  const staffed = [service, ...chain].filter((s) => s.staffMode !== "NONE");
  const staff = staffed.length
    ? staffed[0].staff.filter((p) => staffed.every((s) => s.staff.some((q) => q.id === p.id)))
    : [];
  const staffMode = staffed.some((s) => s.staffMode === "REQUIRED")
    ? "REQUIRED"
    : staffed.length
      ? "OPTIONAL"
      : "NONE";

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
    duration: chainMinutes([service, ...chain].map((s) => s.geometry)),
    questions: service.questions,
    signature: service.requireSignature,
    // Every active service of the shop: picking one in the popup switches
    // to it (calendar, times, staff, add-ons, cart line).
    services: all.map(({ variantId, service: s }) => ({
      variantId,
      title: s.title,
      duration: s.geometry.durationMinutes,
    })),
    staffMode,
    staff,
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
