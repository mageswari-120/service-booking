import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import db from "../../db.server";
import {
  markVariantAsService,
  setVariantBookable,
  setVariantUpsells,
  syncServiceCount,
} from "../services/shopify.server";

/**
 * Demo data for a salon, matching the booking popup's reference design: six
 * services, two add-on products and two stylists. Created from the app's home
 * page ("Create demo data") with the merchant's own admin session.
 *
 * Idempotent: products carry the DEMO_TAG and are found again by title, and
 * services/staff are upserted, so a second run creates nothing new.
 */

export const DEMO_TAG = "service-booking-demo";

const SERVICES = [
  { title: "Signature Cut & Finish", price: 1400, minutes: 60, stylists: true, addons: true },
  { title: "Express Blow-Dry", price: 650, minutes: 30, stylists: true, addons: false },
  { title: "Balayage & Gloss", price: 6800, minutes: 180, stylists: true, addons: false },
  { title: "Deep Tissue Massage", price: 2600, minutes: 90, stylists: false, addons: false },
  { title: "Bridal Hair Trial", price: 9500, minutes: 120, stylists: true, addons: false },
  { title: "Rooftop Yoga — Morning Flow", price: 700, minutes: 60, stylists: false, addons: false },
];

const ADDONS = [
  { title: "Olaplex Bond Treatment", price: 900 },
  { title: "Scalp Massage", price: 450 },
];

const STYLISTS = ["Anitha R.", "Divya S."];

/** Tuesday–Sunday 10:00–17:00; no Monday window, so Mondays are closed. */
const OPEN_DAYS = [0, 2, 3, 4, 5, 6];
const OPEN_FROM = 10 * 60;
const OPEN_TO = 17 * 60;
const CLOSED_DATE = "2026-11-25"; // staff training

export interface DemoResult {
  created: string[];
  reused: string[];
  /** Duplicate demo products deleted (an earlier run that overlapped). */
  removed: string[];
  warnings: string[];
}

const FIND_QUERY = `#graphql
  query DemoProducts($query: String!) {
    products(first: 100, query: $query, sortKey: CREATED_AT) {
      nodes { id title variants(first: 1) { nodes { id } } }
    }
  }
`;

const DELETE_MUTATION = `#graphql
  mutation DemoProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) { deletedProductId userErrors { field message } }
  }
`;

const CREATE_MUTATION = `#graphql
  mutation DemoProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id title variants(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }
`;

const PRICE_MUTATION = `#graphql
  mutation DemoPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }
`;

const PUBLICATIONS_QUERY = `#graphql
  query DemoPublications { publications(first: 20) { nodes { id name } } }
`;

const PUBLISH_MUTATION = `#graphql
  mutation DemoPublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) { userErrors { field message } }
  }
`;

type ProductNode = { id: string; title: string; variants: { nodes: { id: string }[] } };

async function gql<T>(
  admin: AdminApiContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: T; errors?: { message: string }[] }> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  return (await res.json()) as { data?: T; errors?: { message: string }[] };
}

/**
 * Create (or find) one demo product with its default variant priced.
 * Returns the product and variant GIDs, or null with a warning.
 */
async function ensureProduct(
  admin: AdminApiContext,
  existing: ProductNode[],
  spec: { title: string; price: number; description: string },
  result: DemoResult,
): Promise<{ productId: string; variantId: string } | null> {
  const found = existing.find((p) => p.title === spec.title && p.variants.nodes[0]);
  if (found) {
    result.reused.push(spec.title);
    return { productId: found.id, variantId: found.variants.nodes[0].id };
  }

  const created = await gql<{
    productCreate: { product: ProductNode | null; userErrors: { message: string }[] };
  }>(admin, CREATE_MUTATION, {
    product: {
      title: spec.title,
      descriptionHtml: `<p>${spec.description}</p>`,
      status: "ACTIVE",
      tags: [DEMO_TAG],
    },
  });
  const product = created.data?.productCreate.product;
  const errors = created.data?.productCreate.userErrors ?? created.errors ?? [];
  if (!product || !product.variants.nodes[0]) {
    result.warnings.push(`${spec.title}: ${errors.map((e) => e.message).join(" ") || "not created"}`);
    return null;
  }
  const variantId = product.variants.nodes[0].id;
  const priced = await gql<{ productVariantsBulkUpdate: { userErrors: { message: string }[] } }>(
    admin,
    PRICE_MUTATION,
    { productId: product.id, variants: [{ id: variantId, price: spec.price.toFixed(2) }] },
  );
  const priceErrors = priced.data?.productVariantsBulkUpdate.userErrors ?? priced.errors ?? [];
  if (priceErrors.length) {
    result.warnings.push(`${spec.title}: price not set (${priceErrors.map((e) => e.message).join(" ")})`);
  }
  result.created.push(spec.title);
  return { productId: product.id, variantId };
}

/**
 * Put the products on the Online Store. Needs the publications scopes, which
 * the app doesn't ask for: when refused, say so and leave it to the merchant
 * (Products → select → "Include in sales channels").
 */
async function publish(admin: AdminApiContext, productIds: string[], result: DemoResult) {
  if (!productIds.length) return;
  const pubs = await gql<{ publications: { nodes: { id: string; name: string }[] } }>(
    admin,
    PUBLICATIONS_QUERY,
  ).catch(() => null);
  const store = pubs?.data?.publications.nodes.find((p) => p.name === "Online Store");
  if (!store) {
    result.warnings.push(
      "The demo products aren't on the Online Store yet: the app needs the new “publications” permission. Restart `shopify app dev`, open the app, approve the permission update, then click Create salon demo again — or, in Products, select them and use “Include in sales channels”.",
    );
    return;
  }
  for (const id of productIds) {
    const res = await gql<{ publishablePublish: { userErrors: { message: string }[] } }>(
      admin,
      PUBLISH_MUTATION,
      { id, input: [{ publicationId: store.id }] },
    ).catch(() => null);
    if (!res?.data || res.data.publishablePublish.userErrors.length) {
      result.warnings.push(
        "Some products couldn't be published: in Products, select them and use “Include in sales channels”.",
      );
      return;
    }
  }
}

/** Runs in progress, per shop: a second click joins the first run. */
const running = new Map<string, Promise<DemoResult>>();

export function createSalonDemo(
  admin: AdminApiContext,
  shop: { id: string },
): Promise<DemoResult> {
  let run = running.get(shop.id);
  if (!run) {
    run = runSalonDemo(admin, shop).finally(() => running.delete(shop.id));
    running.set(shop.id, run);
  }
  return run;
}

/**
 * Two runs that overlapped created some demo products twice. Per title keep
 * one — the oldest with a service in the app, else the oldest — and delete
 * the rest, with their services (only when those have no bookings).
 * Returns the products kept.
 */
async function removeDuplicates(
  admin: AdminApiContext,
  shop: { id: string },
  products: ProductNode[],
  result: DemoResult,
): Promise<ProductNode[]> {
  const services = await db.service.findMany({
    where: { shopId: shop.id, shopifyProductId: { in: products.map((p) => p.id) } },
    select: { id: true, shopifyProductId: true, _count: { select: { bookings: true } } },
  });
  const serviceOf = new Map(services.map((s) => [s.shopifyProductId, s]));
  const kept: ProductNode[] = [];

  // `products` is oldest first (sortKey CREATED_AT).
  for (const title of new Set(products.map((p) => p.title))) {
    const same = products.filter((p) => p.title === title);
    const keep = same.find((p) => serviceOf.has(p.id)) ?? same[0];
    kept.push(keep);
    for (const extra of same) {
      if (extra === keep) continue;
      const service = serviceOf.get(extra.id);
      if (service && service._count.bookings > 0) {
        result.warnings.push(`${title}: a duplicate has bookings, so it was kept.`);
        kept.push(extra);
        continue;
      }
      if (service) await db.service.delete({ where: { id: service.id } });
      const res = await gql<{ productDelete: { userErrors: { message: string }[] } }>(
        admin,
        DELETE_MUTATION,
        { input: { id: extra.id } },
      );
      const errors = res.data?.productDelete.userErrors ?? res.errors ?? [];
      if (errors.length) {
        result.warnings.push(`${title}: duplicate not deleted (${errors.map((e) => e.message).join(" ")})`);
      } else {
        result.removed.push(title);
      }
    }
  }
  return kept;
}

async function runSalonDemo(
  admin: AdminApiContext,
  shop: { id: string },
): Promise<DemoResult> {
  const result: DemoResult = { created: [], reused: [], removed: [], warnings: [] };
  const found = await gql<{ products: { nodes: ProductNode[] } }>(admin, FIND_QUERY, {
    query: `tag:${DEMO_TAG}`,
  });
  const existing = await removeDuplicates(admin, shop, found.data?.products.nodes ?? [], result);

  // Add-on products first: the Signature Cut offers them.
  const addonIds: string[] = [];
  // Every demo product, created or reused: publishing is idempotent, so a
  // re-run also puts earlier ones on the Online Store.
  const demoProducts: string[] = [];
  for (const a of ADDONS) {
    const p = await ensureProduct(
      admin,
      existing,
      { ...a, description: "Add-on for your appointment." },
      result,
    );
    if (!p) continue;
    addonIds.push(p.variantId);
    demoProducts.push(p.productId);
  }

  // Stylists, reusing any with the same name.
  const stylistIds: string[] = [];
  for (const [i, name] of STYLISTS.entries()) {
    const staff =
      (await db.staff.findFirst({ where: { shopId: shop.id, name } })) ??
      (await db.staff.create({ data: { shopId: shop.id, name, sortOrder: i } }));
    stylistIds.push(staff.id);
  }

  for (const s of SERVICES) {
    const p = await ensureProduct(
      admin,
      existing,
      { title: s.title, price: s.price, description: `${s.minutes}-minute appointment.` },
      result,
    );
    if (!p) continue;
    demoProducts.push(p.productId);

    const upsells = s.addons ? addonIds : [];
    const fields = {
      shopifyProductId: p.productId,
      title: s.title,
      active: true,
      durationMinutes: s.minutes,
      leadTimeMinutes: 60,
      maxAdvanceDays: 365,
      capacityPerSlot: 4,
      capacityMode: "PEOPLE" as const,
      minSeatsPerBooking: 1,
      maxSeatsPerBooking: 4,
      timezone: "Asia/Kolkata",
      staffMode: s.stylists ? ("OPTIONAL" as const) : ("NONE" as const),
      upsellVariantIds: upsells,
    };
    await db.$transaction(async (tx) => {
      const service = await tx.service.upsert({
        where: { shopId_shopifyVariantId: { shopId: shop.id, shopifyVariantId: p.variantId } },
        update: fields,
        create: { ...fields, shopId: shop.id, shopifyVariantId: p.variantId },
      });
      await tx.availabilityRule.deleteMany({ where: { serviceId: service.id } });
      await tx.availabilityRule.createMany({
        data: OPEN_DAYS.map((dayOfWeek) => ({
          serviceId: service.id,
          dayOfWeek,
          startMinute: OPEN_FROM,
          endMinute: OPEN_TO,
        })),
      });
      await tx.capacityOverride.deleteMany({ where: { serviceId: service.id, date: CLOSED_DATE } });
      await tx.capacityOverride.create({
        data: { serviceId: service.id, date: CLOSED_DATE, startMinute: null, endMinute: null, capacity: 0 },
      });
      await tx.serviceStaff.deleteMany({ where: { serviceId: service.id } });
      if (s.stylists) {
        await tx.serviceStaff.createMany({
          data: stylistIds.map((staffId) => ({ serviceId: service.id, staffId })),
        });
      }
    });

    // Shopify side, as the service editor does on save.
    const errors = [
      await markVariantAsService(admin, p.productId, p.variantId),
      await setVariantBookable(admin, p.variantId, true),
      await setVariantUpsells(admin, p.variantId, upsells),
    ].filter(Boolean);
    if (errors.length) result.warnings.push(`${s.title}: ${errors.join(" ")}`);
  }

  await publish(admin, demoProducts, result);
  await syncServiceCount(admin, shop.id);
  return result;
}
