import type { LoaderFunctionArgs } from "@remix-run/node";

import { loadBookableService } from "../lib/booking/context.server";
import { NOT_BOOKABLE, proxyContext, proxyJson } from "../lib/booking/proxy.server";

const UPSELLS_QUERY = `#graphql
  query ServiceUpsells($ids: [ID!]!) {
    shop { currencyCode }
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        price
        availableForSale
        image { url(transform: { maxWidth: 120 }) }
        product {
          title
          hasOnlyDefaultVariant
          featuredImage { url(transform: { maxWidth: 120 }) }
        }
      }
    }
  }
`;

type VariantNode = {
  id?: string;
  title?: string;
  price?: string;
  availableForSale?: boolean;
  image?: { url: string } | null;
  product?: {
    title: string;
    hasOnlyDefaultVariant: boolean;
    featuredImage?: { url: string } | null;
  };
} | null;

/**
 * GET /apps/booking/upsells?variant=<id>
 *
 * A service's add-on products for the popup's second step, when the theme
 * block didn't render them in Liquid — the customer switched to a service
 * sold on another product. Same rows as the Liquid template: available
 * variants only, price in cents (shop currency).
 *
 * `{ currency, items: [{ id, title, variantTitle, price, image }] }`; empty
 * items when the service has none or the shop has no offline session.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, admin } = await proxyContext(request);
  const variant = new URL(request.url).searchParams.get("variant") ?? "";
  const service = shop ? await loadBookableService(shop, variant) : null;
  if (!service) return proxyJson(NOT_BOOKABLE, 404);
  if (!admin || !service.upsellVariantIds.length) return proxyJson({ currency: null, items: [] });

  try {
    const res = await admin.graphql(UPSELLS_QUERY, {
      variables: { ids: service.upsellVariantIds },
    });
    const body = (await res.json()) as {
      data?: { shop?: { currencyCode?: string }; nodes?: VariantNode[] };
    };
    const items = (body.data?.nodes ?? [])
      .filter((n): n is NonNullable<VariantNode> => !!n?.id && n.availableForSale === true)
      .map((n) => ({
        id: n.id!.split("/").pop(),
        title: n.product?.title ?? "",
        variantTitle: n.product?.hasOnlyDefaultVariant ? null : (n.title ?? null),
        price: Math.round(Number(n.price ?? 0) * 100),
        image: n.image?.url ?? n.product?.featuredImage?.url ?? null,
      }));
    return proxyJson({ currency: body.data?.shop?.currencyCode ?? null, items });
  } catch (error) {
    console.error(`[upsells] ${shop}: lookup failed`, error);
    return proxyJson({ currency: null, items: [] });
  }
};
