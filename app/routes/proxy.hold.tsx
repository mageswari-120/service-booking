import type { ActionFunctionArgs } from "@remix-run/node";

import { loadBookableService } from "../lib/booking/context.server";
import { NOT_BOOKABLE, proxyJson, proxyShop } from "../lib/booking/proxy.server";
import { createHold } from "../lib/holds/holds.server";

/**
 * POST /apps/booking/hold  { variant, start, release? }
 *
 * Reserve the slot the customer clicked. 409 means it filled (or stopped being
 * offered) since the list was loaded; the widget then reloads the day.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return proxyJson({ error: "Method not allowed" }, 405);

  const shop = await proxyShop(request);

  let body: { variant?: unknown; start?: unknown; release?: unknown };
  try {
    body = await request.json();
  } catch {
    return proxyJson({ error: "Expected a JSON body" }, 400);
  }

  const service = shop ? await loadBookableService(shop, String(body.variant ?? "")) : null;
  if (!service) return proxyJson(NOT_BOOKABLE, 404);

  const startsAt = new Date(String(body.start ?? ""));
  if (Number.isNaN(startsAt.getTime())) {
    return proxyJson({ error: "Invalid start time" }, 400);
  }

  const release = typeof body.release === "string" ? body.release : null;
  const result = await createHold(service, startsAt, release);
  if (!result.ok) {
    return proxyJson({ error: "That time was just taken. Please pick another." }, 409);
  }

  return proxyJson({
    token: result.token,
    start: startsAt.toISOString(),
    expiresAt: result.expiresAt.toISOString(),
  });
};
