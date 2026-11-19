import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../../db.server";

const VARIANT_QUERY = `#graphql
  query ServiceVariant($id: ID!) {
    productVariant(id: $id) {
      id
      displayName
      product { id title }
    }
  }
`;

const MARK_AS_SERVICE_MUTATION = `#graphql
  mutation MarkVariantAsService($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

const SET_METAFIELD_MUTATION = `#graphql
  mutation SetServiceMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

const DELETE_METAFIELD_MUTATION = `#graphql
  mutation DeleteServiceMetafield($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key }
      userErrors { field message }
    }
  }
`;

export interface VariantInfo {
  variantId: string;
  productId: string;
  productTitle: string;
  displayName: string;
}

/**
 * Re-read the variant the merchant picked. The picker runs in the browser, so
 * the IDs it posts are untrusted: this confirms the variant exists on this shop
 * and that it belongs to the product the form claims.
 */
export async function fetchVariant(
  admin: AdminApiContext,
  variantId: string,
): Promise<VariantInfo | null> {
  const response = await admin.graphql(VARIANT_QUERY, {
    variables: { id: variantId },
  });
  const body = (await response.json()) as {
    data?: {
      productVariant?: {
        id: string;
        displayName: string;
        product: { id: string; title: string };
      } | null;
    };
  };
  const variant = body.data?.productVariant;
  if (!variant) return null;
  return {
    variantId: variant.id,
    productId: variant.product.id,
    productTitle: variant.product.title,
    displayName: variant.displayName,
  };
}

/**
 * Make the variant behave like a bookable service at checkout: no shipping
 * address, no inventory tracking. Capacity is the app's job (SlotHold +
 * Booking), and a tracked variant would sell out after N bookings in total
 * rather than N per slot.
 *
 * Returns the user-facing error, or null on success.
 */
export async function markVariantAsService(
  admin: AdminApiContext,
  productId: string,
  variantId: string,
): Promise<string | null> {
  const response = await admin.graphql(MARK_AS_SERVICE_MUTATION, {
    variables: {
      productId,
      variants: [
        {
          id: variantId,
          inventoryItem: { requiresShipping: false, tracked: false },
        },
      ],
    },
  });
  const body = (await response.json()) as {
    data?: {
      productVariantsBulkUpdate?: {
        userErrors: { field: string[] | null; message: string }[];
      };
    };
  };
  const userErrors = body.data?.productVariantsBulkUpdate?.userErrors ?? [];
  return userErrors.length > 0
    ? userErrors.map((e) => e.message).join(" ")
    : null;
}

/**
 * Flag the variant as bookable (or not) in a metafield the storefront block
 * reads in Liquid, so the theme can show "Select a time" at render time
 * instead of waiting on an app proxy round trip. The proxy stays the source of
 * truth: the widget still checks it and backs out if the flag is stale.
 *
 * Returns the user-facing error, or null on success.
 */
export async function setVariantBookable(
  admin: AdminApiContext,
  variantId: string,
  bookable: boolean,
): Promise<string | null> {
  return setMetafield(admin, variantId, "bookable", "boolean", String(bookable));
}

/**
 * Offer a service as an add-on on another product's page: the product's
 * service_booking.addon_service metafield points at the service variant, and
 * the theme block ("On the page") renders the add-on card from it in Liquid.
 * Null removes it. A product carries one add-on service.
 *
 * Returns the user-facing error, or null on success.
 */
export async function setProductAddon(
  admin: AdminApiContext,
  productId: string,
  serviceVariantId: string | null,
): Promise<string | null> {
  if (!serviceVariantId) return deleteMetafield(admin, productId, "addon_service");
  return setMetafield(admin, productId, "addon_service", "variant_reference", serviceVariantId);
}

const PRODUCT_TITLES_QUERY = `#graphql
  query AddonProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title }
    }
  }
`;

/** Titles for product GIDs, keyed by ID; products not found are left out. */
export async function fetchProductTitles(
  admin: AdminApiContext,
  productIds: string[],
): Promise<Record<string, string>> {
  if (productIds.length === 0) return {};
  const response = await admin.graphql(PRODUCT_TITLES_QUERY, { variables: { ids: productIds } });
  const body = (await response.json()) as {
    data?: { nodes?: ({ id?: string; title?: string } | null)[] };
  };
  const titles: Record<string, string> = {};
  for (const node of body.data?.nodes ?? []) {
    if (node?.id && node.title) titles[node.id] = node.title;
  }
  return titles;
}

/**
 * The add-on variants offered in the booking popup, as a variant-reference
 * list on the service variant. The theme block renders them in Liquid (title,
 * image, price) so the popup needs no request to show them.
 *
 * Returns the user-facing error, or null on success.
 */
export async function setVariantUpsells(
  admin: AdminApiContext,
  variantId: string,
  upsellVariantIds: string[],
): Promise<string | null> {
  // A list metafield can't be set to empty: remove it instead.
  if (upsellVariantIds.length === 0) return deleteMetafield(admin, variantId, "upsells");
  return setMetafield(
    admin,
    variantId,
    "upsells",
    "list.variant_reference",
    JSON.stringify(upsellVariantIds),
  );
}

/**
 * The add-on card's wording, as one JSON metafield on the service variant so
 * the theme block can render the card in Liquid without a request. All three
 * blank removes it: the block then falls back to the service product's own
 * title and description.
 *
 * Returns the user-facing error, or null on success.
 */
export async function setVariantAddonCard(
  admin: AdminApiContext,
  variantId: string,
  card: { label: string | null; description: string | null; badge: string | null },
): Promise<string | null> {
  const value: Record<string, string> = {};
  if (card.label) value.label = card.label;
  if (card.description) value.description = card.description;
  if (card.badge) value.badge = card.badge;
  if (Object.keys(value).length === 0) {
    return deleteMetafield(admin, variantId, "addon_card");
  }
  return setMetafield(admin, variantId, "addon_card", "json", JSON.stringify(value));
}

async function deleteMetafield(
  admin: AdminApiContext,
  ownerId: string,
  key: string,
): Promise<string | null> {
  const response = await admin.graphql(DELETE_METAFIELD_MUTATION, {
    variables: { metafields: [{ ownerId, namespace: "service_booking", key }] },
  });
  const body = (await response.json()) as {
    data?: { metafieldsDelete?: { userErrors: { message: string }[] } };
  };
  const errors = body.data?.metafieldsDelete?.userErrors ?? [];
  return errors.length > 0 ? errors.map((e) => e.message).join(" ") : null;
}

async function setMetafield(
  admin: AdminApiContext,
  ownerId: string,
  key: string,
  type: string,
  value: string,
): Promise<string | null> {
  const response = await admin.graphql(SET_METAFIELD_MUTATION, {
    variables: {
      metafields: [{ ownerId, namespace: "service_booking", key, type, value }],
    },
  });
  const body = (await response.json()) as {
    data?: {
      metafieldsSet?: {
        userErrors: { field: string[] | null; message: string }[];
      };
    };
  };
  const userErrors = body.data?.metafieldsSet?.userErrors ?? [];
  return userErrors.length > 0
    ? userErrors.map((e) => e.message).join(" ")
    : null;
}

const SHOP_ID_QUERY = `#graphql
  query ServiceBookingShopId { shop { id } }
`;

const SELLABLE_QUERY = `#graphql
  query ServiceBookingSellable($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant { id product { status publishedAt } }
    }
  }
`;

/**
 * Two shop metafields the theme blocks read in Liquid:
 *
 *   service_booking.service_count — how many active services the shop has.
 *     With more than one, the booking popup opens on the service cards, so
 *     it renders their skeleton (not the calendar's) while loading.
 *   service_booking.default_variant — the service the "Booking calendar"
 *     block's popup starts on (its first /availability call needs one; the
 *     cards switch from there): the first active service by title whose
 *     product is on the Online Store, else simply the first.
 *
 * Best effort: a stale count only changes which skeleton shows first; a
 * stale default is still switchable from the cards.
 */
export async function syncServiceCount(admin: AdminApiContext, shopId: string): Promise<void> {
  try {
    const [rows, res] = await Promise.all([
      db.service.findMany({
        where: { shopId, active: true },
        select: { shopifyVariantId: true },
        orderBy: [{ title: "asc" }, { id: "asc" }],
        take: 50,
      }),
      admin.graphql(SHOP_ID_QUERY),
    ]);
    const body = (await res.json()) as { data?: { shop?: { id?: string } } };
    const shopGid = body.data?.shop?.id;
    if (!shopGid) return;
    const error = await setMetafield(admin, shopGid, "service_count", "number_integer", String(rows.length));
    if (error) console.error(`[services] service_count metafield not set: ${error}`);

    let first = rows[0]?.shopifyVariantId ?? null;
    if (rows.length > 1) {
      try {
        const sell = await admin.graphql(SELLABLE_QUERY, {
          variables: { ids: rows.map((r) => r.shopifyVariantId) },
        });
        const sb = (await sell.json()) as {
          data?: { nodes?: ({ id?: string; product?: { status?: string; publishedAt?: string | null } } | null)[] };
        };
        const ok = (sb.data?.nodes ?? []).find((n) => n?.id && n.product?.status === "ACTIVE" && n.product.publishedAt);
        if (ok?.id) first = ok.id;
      } catch {
        // Keep the first by title.
      }
    }
    const variant = first ? first.split("/").pop() ?? "" : "";
    const defaultError = variant
      ? await setMetafield(admin, shopGid, "default_variant", "single_line_text_field", variant)
      : await deleteMetafield(admin, shopGid, "default_variant");
    if (defaultError) console.error(`[services] default_variant metafield not set: ${defaultError}`);
  } catch (error) {
    console.error("[services] service_count metafield sync failed", error);
  }
}
