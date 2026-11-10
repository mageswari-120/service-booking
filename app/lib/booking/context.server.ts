import type { Prisma, PrismaClient } from "@prisma/client";

import db from "../../db.server";
import { resolveTimezone } from "../shop.server";
import type {
  ComputeSlotsParams,
  Interval,
  ServiceGeometry,
  SlotUsage,
  WeeklyWindow,
} from "../slots/types";

/** Either the shared client or the client inside a `$transaction`. */
type Db = PrismaClient | Prisma.TransactionClient;

export interface BookableService {
  id: string;
  shopId: string;
  title: string;
  holdTtlMinutes: number;
  geometry: ServiceGeometry;
  windows: WeeklyWindow[];
}

/**
 * The active service a storefront variant is sold as, or null when the variant
 * isn't bookable (not linked, paused, or the shop uninstalled). The storefront
 * sends a numeric variant ID; services store the GID.
 */
export async function loadBookableService(
  shopDomain: string,
  variantId: string,
): Promise<BookableService | null> {
  if (!/^\d+$/.test(variantId)) return null;

  const service = await db.service.findFirst({
    where: {
      shopifyVariantId: `gid://shopify/ProductVariant/${variantId}`,
      active: true,
      shop: { domain: shopDomain, uninstalledAt: null },
    },
    include: {
      shop: { select: { timezone: true, holdTtlMinutes: true } },
      availabilityRules: true,
    },
  });
  if (!service) return null;

  return {
    id: service.id,
    shopId: service.shopId,
    title: service.title,
    holdTtlMinutes: service.shop.holdTtlMinutes,
    geometry: {
      durationMinutes: service.durationMinutes,
      bufferBeforeMinutes: service.bufferBeforeMinutes,
      bufferAfterMinutes: service.bufferAfterMinutes,
      slotIntervalMinutes: service.slotIntervalMinutes,
      leadTimeMinutes: service.leadTimeMinutes,
      maxAdvanceDays: service.maxAdvanceDays,
      capacityPerSlot: service.capacityPerSlot,
      timezone: resolveTimezone(service.timezone, service.shop.timezone),
    },
    windows: service.availabilityRules.map((r) => ({
      dayOfWeek: r.dayOfWeek,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
    })),
  };
}

/**
 * Everything `computeSlots` needs for [rangeStart, rangeEnd), read fresh.
 *
 * Pass the transaction client from the hold manager so the capacity count and
 * the insert see the same snapshot under the advisory lock.
 */
export async function buildSlotParams(
  service: BookableService,
  rangeStart: Date,
  rangeEnd: Date,
  now: Date,
  client: Db = db,
): Promise<ComputeSlotsParams> {
  // Buffers can reach past the range, so widen the blackout read by a day.
  const pad = 24 * 60 * 60_000;
  const blackoutFrom = new Date(rangeStart.getTime() - pad);
  const blackoutTo = new Date(rangeEnd.getTime() + pad);

  const [blackoutRows, holdRows, bookingRows] = await Promise.all([
    client.blackout.findMany({
      where: {
        shopId: service.shopId,
        OR: [{ serviceId: null }, { serviceId: service.id }],
        startsAt: { lt: blackoutTo },
        endsAt: { gt: blackoutFrom },
      },
      select: { startsAt: true, endsAt: true },
    }),
    client.slotHold.groupBy({
      by: ["startsAt"],
      where: {
        serviceId: service.id,
        consumedAt: null,
        expiresAt: { gt: now },
        startsAt: { gte: rangeStart, lt: rangeEnd },
      },
      _count: { _all: true },
    }),
    client.booking.groupBy({
      by: ["startsAt"],
      where: {
        serviceId: service.id,
        status: "CONFIRMED",
        startsAt: { gte: rangeStart, lt: rangeEnd },
      },
      _count: { _all: true },
    }),
  ]);

  const blackouts: Interval[] = blackoutRows;
  const usage: SlotUsage[] = [
    ...holdRows.map((r) => ({ startsAt: r.startsAt, count: r._count._all })),
    ...bookingRows.map((r) => ({ startsAt: r.startsAt, count: r._count._all })),
  ];

  return {
    service: service.geometry,
    windows: service.windows,
    blackouts,
    usage,
    rangeStart,
    rangeEnd,
    now,
  };
}
