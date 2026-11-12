import type { ActionFunctionArgs } from "@remix-run/node";

import { loadBookableService } from "../lib/booking/context.server";
import { validateHoldDetails } from "../lib/booking/details";
import { NOT_BOOKABLE, proxyJson, proxyShop } from "../lib/booking/proxy.server";
import { createHold } from "../lib/holds/holds.server";

/**
 * POST /apps/booking/hold  { variant, start, seats?, answers?, signature?, release? }
 *
 * Reserve `seats` at the time the customer picked, with the popup's second
 * step (intake answers, signature) stored on the hold. 400 `{ error, field }`
 * when a detail is missing or invalid; 409 when the time filled (or stopped
 * being offered) since the list was loaded — the widget then goes back to the
 * calendar and reloads.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return proxyJson({ error: "Method not allowed" }, 405);
  const t0 = performance.now();

  const shop = await proxyShop(request);

  let body: {
    variant?: unknown;
    start?: unknown;
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
      capacityPerSlot: service.geometry.capacityPerSlot,
    },
    body,
  );
  if (!details.ok) return proxyJson({ error: details.error, field: details.field }, 400);

  const release = typeof body.release === "string" ? body.release : null;
  const holdStart = performance.now();
  const result = await createHold(service, startsAt, release, details);
  const timing = `service;dur=${(holdStart - t0).toFixed(0)}, hold;dur=${(performance.now() - holdStart).toFixed(0)}`;
  if (!result.ok) {
    return withTiming(
      proxyJson({ error: "That time was just taken. Please pick another." }, 409),
      timing,
    );
  }

  return withTiming(
    proxyJson({
      token: result.token,
      start: startsAt.toISOString(),
      seats: details.seats,
      expiresAt: result.expiresAt.toISOString(),
    }),
    timing,
  );
};

/** DevTools → Network → Timing shows where the hold's time went. */
function withTiming(res: Response, timing: string): Response {
  res.headers.set("Server-Timing", timing);
  return res;
}
