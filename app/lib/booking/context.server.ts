import type { CapacityMode, Prisma, PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";

import db from "../../db.server";
import { resolveTimezone } from "../shop.server";
import { parseQuestions, type IntakeQuestion } from "./details";
import type {
  CapacityOverride,
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
  /** Date-specific slot limits from yesterday on (service timezone). */
  overrides: CapacityOverride[];
  /** PEOPLE: slot limits count seats. BOOKINGS: they count bookings. */
  capacityMode: CapacityMode;
  /** Smallest party one booking may be. */
  minSeats: number;
  /**
   * Largest party one booking may be. Null => only the seats left in the slot
   * limit it (PEOPLE mode; BOOKINGS mode always has a number).
   */
  maxSeats: number | null;
  /** Asked in the popup's second step. */
  questions: IntakeQuestion[];
  requireSignature: boolean;
}

/** The service relations `toBookableService` needs. */
export const bookableInclude = {
  shop: { select: { timezone: true, holdTtlMinutes: true } },
  availabilityRules: true,
  capacityOverrides: true,
} as const;

type ServiceRow = Prisma.ServiceGetPayload<{ include: typeof bookableInclude }>;

/** Party-size bounds for a service row, after mode defaults. */
export function seatLimits(service: {
  capacityMode: CapacityMode;
  minSeatsPerBooking: number;
  maxSeatsPerBooking: number | null;
}): { minSeats: number; maxSeats: number | null } {
  const minSeats = Math.max(1, service.minSeatsPerBooking);
  const maxSeats =
    service.maxSeatsPerBooking ?? (service.capacityMode === "BOOKINGS" ? minSeats : null);
  return { minSeats, maxSeats };
}

export function toBookableService(service: ServiceRow, now: Date = new Date()): BookableService {
  const timezone = resolveTimezone(service.timezone, service.shop.timezone);
  const { minSeats, maxSeats } = seatLimits(service);
  // Overrides for past dates can't matter; keep yesterday for zone edge cases.
  const fromDate = DateTime.fromJSDate(now, { zone: timezone })
    .minus({ days: 1 })
    .toFormat("yyyy-MM-dd");

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
      // A slot is only worth showing if the smallest allowed booking fits.
      minUnitsPerHold: service.capacityMode === "BOOKINGS" ? 1 : minSeats,
      timezone,
    },
    windows: service.availabilityRules.map((r) => ({
      dayOfWeek: r.dayOfWeek,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
      capacity: r.capacity,
    })),
    overrides: service.capacityOverrides
      .filter((o) => o.date >= fromDate)
      .map((o) => ({
        date: o.date,
        startMinute: o.startMinute,
        endMinute: o.endMinute,
        capacity: o.capacity,
      })),
    capacityMode: service.capacityMode,
    minSeats,
    maxSeats,
    questions: parseQuestions(service.intakeQuestions),
    requireSignature: service.requireSignature,
  };
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
    include: bookableInclude,
  });
  return service ? toBookableService(service) : null;
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
      _sum: { seats: true },
      _count: { _all: true },
    }),
    client.booking.groupBy({
      by: ["startsAt"],
      where: {
        serviceId: service.id,
        status: "CONFIRMED",
        startsAt: { gte: rangeStart, lt: rangeEnd },
      },
      _sum: { seats: true },
      _count: { _all: true },
    }),
  ]);

  const blackouts: Interval[] = blackoutRows;
  // PEOPLE mode counts seats (one hold or booking can be several people);
  // BOOKINGS mode counts rows.
  const units = (r: { _sum: { seats: number | null }; _count: { _all: number } }) =>
    service.capacityMode === "BOOKINGS" ? r._count._all : (r._sum.seats ?? 0);
  const usage: SlotUsage[] = [
    ...holdRows.map((r) => ({ startsAt: r.startsAt, count: units(r) })),
    ...bookingRows.map((r) => ({ startsAt: r.startsAt, count: units(r) })),
  ];

  return {
    service: service.geometry,
    windows: service.windows,
    blackouts,
    usage,
    overrides: service.overrides,
    rangeStart,
    rangeEnd,
    now,
  };
}

/** What the storefront widget needs to show and bound the "People" stepper. */
export function seatRules(service: BookableService): {
  mode: "people" | "bookings";
  minSeats: number;
  maxSeats: number | null;
} {
  return {
    mode: service.capacityMode === "BOOKINGS" ? "bookings" : "people",
    minSeats: service.minSeats,
    maxSeats: service.maxSeats,
  };
}
