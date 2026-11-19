import type { LoaderFunctionArgs } from "@remix-run/node";

import { loadBookableServices } from "../lib/booking/context.server";
import { proxyContext, proxyJson } from "../lib/booking/proxy.server";

const SERVICES_QUERY = `#graphql
  query ServiceCards($ids: [ID!]!) {
    shop { currencyCode }
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        price
        image { url(transform: { maxWidth: 160 }) }
        product {
          status
          publishedAt
          featuredImage { url(transform: { maxWidth: 160 }) }
        }
      }
    }
  }
`;

type VariantNode = {
  id?: string;
  price?: string;
  image?: { url: string } | null;
  product?: { status?: string; publishedAt?: string | null; featuredImage?: { url: string } | null };
} | null;

/**
 * GET /apps/booking/services
 *
 * The popup's service cards: every active service of the shop with its
 * Shopify price (cents, shop currency) and image (the variant's, else the
 * product's). Fetched once per page, after the popup's first month load.
 *
 * `{ currency, services: [{ variantId, title, duration, price, image, available }] }`;
 * `available` false hides a service whose product isn't on the Online Store.
 * Without an offline session (or if Shopify fails) price and image are null
 * and the cards fall back to initials and no price.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, admin } = await proxyContext(request);
  const rows = shop ? await loadBookableServices(shop) : [];

  let currency: string | null = null;
  let looked = false; // Shopify answered: a missing node means a deleted variant
  const byId = new Map<string, NonNullable<VariantNode>>();
  if (admin && rows.length) {
    try {
      const res = await admin.graphql(SERVICES_QUERY, {
        variables: { ids: rows.map((r) => `gid://shopify/ProductVariant/${r.variantId}`) },
      });
      const body = (await res.json()) as {
        data?: { shop?: { currencyCode?: string }; nodes?: VariantNode[] };
      };
      currency = body.data?.shop?.currencyCode ?? null;
      looked = !!body.data?.nodes;
      for (const n of body.data?.nodes ?? []) {
        if (n?.id) byId.set(n.id.split("/").pop() ?? "", n);
      }
    } catch (error) {
      console.error(`[services] ${shop}: lookup failed`, error);
    }
  }

  return proxyJson({
    currency,
    services: rows.map(({ variantId, service }) => {
      const n = byId.get(variantId);
      return {
        variantId,
        title: service.title,
        duration: service.geometry.durationMinutes,
        price: n?.price != null ? Math.round(Number(n.price) * 100) : null,
        image: n?.image?.url ?? n?.product?.featuredImage?.url ?? null,
        // On sale on the Online Store (else /cart/add.js answers "Cannot find
        // variant"); null when Shopify couldn't be asked. `publishedAt` is the
        // Online Store publish date — unlike `onlineStoreUrl`, it isn't null
        // while the storefront is password protected.
        available: looked
          ? !!(n?.product?.publishedAt && n.product.status === "ACTIVE")
          : null,
      };
    }),
  });
};
