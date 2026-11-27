import type { Booking, BookingStatus, Prisma } from "@prisma/client";

import db from "../../db.server";
import { loadStaffBusy } from "../booking/context.server";
import { holdSecret, verifyHoldToken } from "../holds/token";
import { resolveTimezone } from "../shop.server";
import { slotCapacity, staffFreeAt } from "../slots/engine";
import { bookingLines, orderCustomer, type OrderPayload } from "./order";

export interface CreatedBooking {
  booking: Booking;
  serviceTitle: string;
  timezone: string;
  /** False when the row already existed (webhook retry). */
  isNew: boolean;
}

const serviceInclude = {
  shop: { select: { domain: true, timezone: true } },
  availabilityRules: true,
  capacityOverrides: true,
} as const;
type ServiceWithShop = Prisma.ServiceGetPayload<{ include: typeof serviceInclude }>;

/**
 * Turn the booking line items of an orders/create payload into Booking rows.
 *
 * Normal path: the line item's signed `_booking_hold` points at a SlotHold,
 * whose seats, intake answers and signature are copied onto the Booking, and
 * the hold is consumed. Anything off (forged/missing token, hold used by
 * another order, slot full after the hold expired) still records the booking
 * — the customer paid — but as CONFLICT with a note for the merchant.
 *
 * Idempotent: Booking is unique on (order, line item), so Shopify's webhook
 * retries return the existing rows.
 */
export async function createBookingsFromOrder(
  shopDomain: string,
  order: OrderPayload,
  now: Date = new Date(),
): Promise<CreatedBooking[]> {
  const lines = bookingLines(order);
  if (!lines.length) return [];

  const orderId = order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`;
  const customer = orderCustomer(order);
  const secret = holdSecret();
  const out: CreatedBooking[] = [];

  for (const line of lines) {
    const hold =
      line.holdToken && verifyHoldToken(line.holdToken, secret)
        ? await db.slotHold.findUnique({
            where: { token: line.holdToken },
            include: { service: { include: serviceInclude } },
          })
        : null;

    let service: ServiceWithShop | null = hold?.service ?? null;
    if (service && service.shop.domain !== shopDomain) service = null;
    if (!service && line.variantId) {
      service = await db.service.findFirst({
        where: {
          shopifyVariantId: `gid://shopify/ProductVariant/${line.variantId}`,
          shop: { domain: shopDomain },
        },
        include: serviceInclude,
      });
    }
    if (!service) {
      console.warn(`[bookings] ${shopDomain} order ${orderId} line ${line.lineItemId}: no matching service`);
      continue;
    }

    const validHold = hold && hold.serviceId === service.id ? hold : null;
    const startsAt = validHold?.startsAt ?? line.start;
    if (!startsAt) {
      console.warn(`[bookings] ${shopDomain} order ${orderId} line ${line.lineItemId}: no start time`);
      continue;
    }
    const svc = service;
    // The hold's staff member is authoritative; the line property is only
    // trusted when it names staff of this shop (e.g. no valid hold).
    let staffId = validHold ? validHold.staffId : null;
    if (!validHold && line.staffId) {
      const named = await db.staff.findFirst({
        where: { id: line.staffId, shopId: svc.shopId },
        select: { id: true },
      });
      staffId = named?.id ?? null;
    }
    const endsAt = new Date(startsAt.getTime() + svc.durationMinutes * 60_000);

    const result = await db.$transaction(async (tx) => {
      const existing = await tx.booking.findUnique({
        where: { shopifyOrderId_shopifyLineItemId: { shopifyOrderId: orderId, shopifyLineItemId: line.lineItemId } },
      });
      if (existing) return { booking: existing, isNew: false };

      // Same locks as createHolds, so the checks below can't race a new hold.
      const keys = [`${svc.id}|${startsAt.toISOString()}`, ...(staffId ? [`staff|${staffId}`] : [])].sort();
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(k)) FROM unnest(${keys}::text[]) AS k`;

      const seats = validHold?.seats ?? line.seats;
      let status: BookingStatus = "CONFIRMED";
      let conflictNote: string | null = null;

      if (!validHold) {
        status = "CONFLICT";
        conflictNote = "No valid slot hold on this order line; check the time is still free.";
      } else if (validHold.consumedAt) {
        status = "CONFLICT";
        conflictNote = "This slot hold was already used by another order.";
      } else if (validHold.expiresAt <= now) {
        // The hold lapsed during checkout: confirm only if the seats are still free.
        const [held, booked] = await Promise.all([
          tx.slotHold.aggregate({
            where: { serviceId: svc.id, startsAt, consumedAt: null, expiresAt: { gt: now } },
            _sum: { seats: true },
            _count: { _all: true },
          }),
          tx.booking.aggregate({
            where: { serviceId: svc.id, startsAt, status: "CONFIRMED" },
            _sum: { seats: true },
            _count: { _all: true },
          }),
        ]);
        // Same units as the slot list: seats (PEOPLE) or bookings (BOOKINGS).
        const byBookings = svc.capacityMode === "BOOKINGS";
        const used = byBookings
          ? held._count._all + booked._count._all
          : (held._sum.seats ?? 0) + (booked._sum.seats ?? 0);
        const needed = byBookings ? 1 : seats;
        const capacity = slotCapacity(
          {
            service: {
              capacityPerSlot: svc.capacityPerSlot,
              timezone: resolveTimezone(svc.timezone, svc.shop.timezone),
            },
            windows: svc.availabilityRules,
            overrides: svc.capacityOverrides,
          },
          startsAt,
        );
        if (used + needed > capacity) {
          status = "CONFLICT";
          conflictNote = "The hold expired during checkout and the slot filled up in the meantime.";
        } else if (staffId) {
          // …and only if the staff member wasn't booked for an overlapping time.
          const busy = await loadStaffBusy(tx, [staffId], startsAt, endsAt, now);
          const free = staffFreeAt(
            { ids: [staffId], busy },
            {
              startsAt: new Date(startsAt.getTime() - svc.bufferBeforeMinutes * 60_000),
              endsAt: new Date(endsAt.getTime() + svc.bufferAfterMinutes * 60_000),
            },
          );
          if (!free?.length) {
            status = "CONFLICT";
            conflictNote =
              "The hold expired during checkout and the staff member was booked for an overlapping time in the meantime.";
          }
        }
      }

      if (validHold && !validHold.consumedAt) {
        await tx.slotHold.update({ where: { id: validHold.id }, data: { consumedAt: now } });
      }

      const booking = await tx.booking.create({
        data: {
          shopId: svc.shopId,
          serviceId: svc.id,
          shopifyOrderId: orderId,
          shopifyOrderName: order.name ?? null,
          shopifyLineItemId: line.lineItemId,
          startsAt,
          endsAt,
          staffId,
          customerName: customer.name,
          customerEmail: customer.email,
          customerPhone: customer.phone,
          customerTimezone: line.timezone,
          status,
          conflictNote,
          intakeAnswers: (validHold?.intakeAnswers ?? undefined) as Prisma.InputJsonValue | undefined,
          holdToken: line.holdToken,
          seats,
          signaturePng: validHold?.signaturePng ?? undefined,
        },
      });
      return { booking, isNew: true };
    });

    out.push({
      ...result,
      serviceTitle: svc.title,
      timezone: result.booking.customerTimezone ?? resolveTimezone(svc.timezone, svc.shop.timezone),
    });
  }
  return out;
}
