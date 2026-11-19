import type { ActionFunctionArgs } from "@remix-run/node";

import { loadBookableService, loadComboServices } from "../lib/booking/context.server";
import { validateHoldDetails } from "../lib/booking/details";
import { NOT_BOOKABLE, proxyJson, proxyShop } from "../lib/booking/proxy.server";
import { createHolds, type HoldItem } from "../lib/holds/holds.server";

/** Most services one popup booking can combine (the first one included). */
const MAX_CHAIN = 6;

/**
 * POST /apps/booking/hold
 *   { variant, start, with?, staff?, seats?, answers?, signature?, release? }
 *
 * Reserve `seats` at the time the customer picked, with the popup's second
 * step (intake answers, signature) stored on the hold.
 *
 * `with`: numeric variant IDs of services added in the popup (they must be
 * among `variant`'s combinable services); they are held back to back after
 * it. `staff`: a staff id, or "any". `release`: the previous hold token(s).
 *
 * 400 `{ error, field }` when a detail is missing or invalid; 409 when the
 * time filled (or stopped being offered) since the list was loaded — the
 * widget then goes back to the calendar and reloads.
 *
 * 200 `{ token, start, seats, expiresAt, staff, holds }`: `token`/`start`
 * are the first service's (what single-service callers read); `holds` lists
 * every service's `{ variant, title, token, start, duration }`.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return proxyJson({ error: "Method not allowed" }, 405);
  const t0 = performance.now();

  const shop = await proxyShop(request);
  const tAuth = performance.now();

  let body: {
    variant?: unknown;
    start?: unknown;
    with?: unknown;
    staff?: unknown;
    release?: unknown;
    seats?: unknown;
    answers?: unknown;
    signature?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return proxyJson({ error: "Expected a JSON body" }, 400);
  }

  const service = shop ? await loadBookableService(shop, String(body.variant ?? "")) : null;
  if (!service) return proxyJson(NOT_BOOKABLE, 404);

  const startsAt = new Date(String(body.start ?? ""));
  if (Number.isNaN(startsAt.getTime())) {
    return proxyJson({ error: "Invalid start time", field: "start" }, 400);
  }

  const details = validateHoldDetails(
    {
      questions: service.questions,
      requireSignature: service.requireSignature,
      minSeats: service.minSeats,
      maxSeats: service.maxSeats,
    },
    body,
  );
  if (!details.ok) return proxyJson({ error: details.error, field: details.field }, 400);

  // Added services: only ones the merchant made combinable with this one.
  const withIds = stringList(body.with);
  if (withIds.length >= MAX_CHAIN) {
    return proxyJson({ error: "Too many services in one booking.", field: "with" }, 400);
  }
  const extra = withIds.length ? await loadComboServices(service, withIds) : [];
  if (extra.length !== new Set(withIds).size) {
    return proxyJson({ error: "One of the services can't be added to this booking.", field: "with" }, 400);
  }
  const items: HoldItem[] = [{ service, details }];
  for (const s of extra) {
    // The same party books every service; questions and signature are the
    // first service's only.
    const seats = validateHoldDetails(
      { questions: [], requireSignature: false, minSeats: s.minSeats, maxSeats: s.maxSeats },
      { seats: details.seats },
    );
    if (!seats.ok) {
      return proxyJson({ error: `${s.title}: ${seats.error}`, field: "seats" }, 400);
    }
    items.push({ service: s, details: { seats: details.seats, answers: [], signaturePng: null } });
  }

  // A specific person must be someone who performs every staffed service.
  const staff = typeof body.staff === "string" && body.staff ? body.staff : null;
  const staffed = items.filter((i) => i.service.staffMode !== "NONE");
  if (staff && staff !== "any") {
    if (!staffed.length || !staffed.every((i) => i.service.staff.some((p) => p.id === staff))) {
      return proxyJson({ error: "Please choose who you'd like to book with.", field: "staff" }, 400);
    }
  }

  const holdStart = performance.now();
  const result = await createHolds(items, startsAt, {
    staff,
    release: stringList(body.release),
  });
  const timing =
    `auth;dur=${(tAuth - t0).toFixed(0)}, service;dur=${(holdStart - tAuth).toFixed(0)}, ` +
    `hold;dur=${(performance.now() - holdStart).toFixed(0)}, total;dur=${(performance.now() - t0).toFixed(0)}`;
  if (!result.ok) {
    return withTiming(
      proxyJson({ error: "That time was just taken. Please pick another." }, 409),
      timing,
    );
  }

  const [first] = result.holds;
  return withTiming(
    proxyJson({
      token: first.token,
      start: first.startsAt.toISOString(),
      seats: details.seats,
      expiresAt: first.expiresAt.toISOString(),
      staff: result.staff,
      holds: result.holds.map((h) => ({
        variant: h.service.variantId,
        title: h.service.title,
        token: h.token,
        start: h.startsAt.toISOString(),
        duration: h.service.geometry.durationMinutes,
        // Cart quantity: the party size, or 1 when priced per booking.
        perPerson: h.service.chargePerPerson,
      })),
    }),
    timing,
  );
};

/** A string or an array of strings from the JSON body; anything else is []. */
function stringList(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && !!v).slice(0, 20)
    : [];
}

/** DevTools → Network → Timing shows where the hold's time went. */
function withTiming(res: Response, timing: string): Response {
  res.headers.set("Server-Timing", timing);
  return res;
}
