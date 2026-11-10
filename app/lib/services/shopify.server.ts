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
