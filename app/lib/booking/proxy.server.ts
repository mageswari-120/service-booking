import { authenticate } from "../../shopify.server";

/**
 * Verify an app proxy request and return the shop domain it came from.
 *
 * `authenticate.public.appProxy` checks Shopify's HMAC signature and throws a
 * 400 on a forged request, so the `shop` query param is trustworthy after it.
 */
export async function proxyShop(request: Request): Promise<string | null> {
  await authenticate.public.appProxy(request);
  return new URL(request.url).searchParams.get("shop");
}

/**
 * JSON for the storefront widget. Availability changes by the second, and a
 * cached slot list is how two customers end up holding the same seat, so
 * nothing here is ever cacheable.
 */
export function proxyJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export const NOT_BOOKABLE = { bookable: false } as const;
