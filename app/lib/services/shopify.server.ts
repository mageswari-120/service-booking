import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

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
  return setVariantMetafield(admin, variantId, "bookable", "boolean", String(bookable));
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
  if (upsellVariantIds.length === 0) {
    const response = await admin.graphql(DELETE_METAFIELD_MUTATION, {
      variables: {
        metafields: [{ ownerId: variantId, namespace: "service_booking", key: "upsells" }],
      },
    });
    const body = (await response.json()) as {
      data?: { metafieldsDelete?: { userErrors: { message: string }[] } };
    };
    const errors = body.data?.metafieldsDelete?.userErrors ?? [];
    return errors.length > 0 ? errors.map((e) => e.message).join(" ") : null;
  }
  return setVariantMetafield(
    admin,
    variantId,
    "upsells",
    "list.variant_reference",
    JSON.stringify(upsellVariantIds),
  );
}

async function setVariantMetafield(
  admin: AdminApiContext,
  variantId: string,
  key: string,
  type: string,
  value: string,
): Promise<string | null> {
  const response = await admin.graphql(SET_METAFIELD_MUTATION, {
    variables: {
      metafields: [{ ownerId: variantId, namespace: "service_booking", key, type, value }],
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
