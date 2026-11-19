import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";

import db from "../../db.server";
import {
  staffAvailability,
  type BookableService,
  type StaffMember,
} from "../booking/context.server";
import type { IntakeAnswer } from "../booking/details";
import { chainStarts, computeSlots, evaluateAt } from "../slots/engine";
import type { ComputeSlotsParams, Interval, SlotUsage } from "../slots/types";
import { holdSecret, signHoldToken, verifyHoldToken } from "./token";

/** What validateHoldDetails accepted for one service of the booking. */
export interface HoldDetails {
  seats: number;
  answers: IntakeAnswer[];
  signaturePng: Buffer | null;
}

export interface HoldItem {
  service: BookableService;
  details: HoldDetails;
}

export interface CreatedHold {
  service: BookableService;
  token: string;
  startsAt: Date;
  expiresAt: Date;
}

export type HoldsResult =
  | { ok: true; holds: CreatedHold[]; staff: StaffMember | null }
  | { ok: false; reason: "unavailable" };

/**
 * Reserve one or more services booked back to back from `startsAt` (the
 * first service at `startsAt`, each next one after the previous ends — see
 * chainStarts), each for its `details.seats`, for the shop's hold time.
 * All of them or none: a 409 never leaves half a booking held.
 *
 * This is the authoritative capacity check — the slot list the customer saw is
 * already stale. Concurrent requests are serialised with transaction-scoped
 * Postgres advisory locks keyed on (service, start) and, for services with
 * staff, on each staff member who could be chosen — so two customers can
 * neither take the last seat nor the same person at overlapping times.
 * Locks are taken in sorted order, so two chains can't deadlock.
 *
 * `staff`: a staff id, or "any"/null to take the first person free for every
 * staffed service. One person does the whole chain.
 *
 * `release` are the customer's previous holds, if they're changing time;
 * they are expired in the same transaction so they never hold two.
 *
 * `details` (already validated by validateHoldDetails) is stored on the hold
 * for the orders handler: seats, and on the first service the intake answers
 * and signature.
 */
export async function createHolds(
  items: HoldItem[],
  startsAt: Date,
  opts: { staff?: string | null; release?: string[] } = {},
  now: Date = new Date(),
): Promise<HoldsResult> {
  if (!items.length) return { ok: false, reason: "unavailable" };
  const secret = holdSecret();
  const starts = chainStarts(
    items.map((i) => i.service.geometry),
    startsAt,
  );
  const staffed = items.map((i) => i.service.staffMode !== "NONE");

  // People who perform every staffed service, in the first one's order.
  let candidates: string[] | null = null;
  items.forEach((item, i) => {
    if (!staffed[i]) return;
    const ids = item.service.staff.map((s) => s.id);
    candidates = candidates ? candidates.filter((id) => ids.includes(id)) : ids;
  });
  const wanted = opts.staff && opts.staff !== "any" ? opts.staff : null;
  if (candidates && wanted) candidates = (candidates as string[]).includes(wanted) ? [wanted] : [];
  const people: string[] | null = candidates;
  if (people && !people.length) return { ok: false, reason: "unavailable" };

  return db.$transaction(async (tx) => {
    const keys = [
      ...new Set([
        ...items.map((it, i) => `${it.service.id}|${starts[i].toISOString()}`),
        ...(people ?? []).map((id) => `staff|${id}`),
      ]),
    ].sort();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(k)) FROM unnest(${keys}::text[]) AS k`;

    const release = (opts.release ?? []).filter((t) => verifyHoldToken(t, secret));
    // One service: expire the old hold inside the snapshot statement (no
    // extra round trip). Several: expire them all first.
    let inlineRelease: string | null = null;
    if (items.length === 1 && release.length <= 1) {
      inlineRelease = release[0] ?? null;
    } else if (release.length) {
      await tx.slotHold.updateMany({
        where: {
          token: { in: release },
          consumedAt: null,
          serviceId: { in: items.map((i) => i.service.id) },
        },
        data: { expiresAt: now },
      });
    }

    let free = people;
    for (let i = 0; i < items.length; i++) {
      const { service, details } = items[i];
      const at = starts[i];
      // Re-run the engine for exactly this instant against fresh usage, so
      // opening hours, blackouts and capacity are all re-checked (lead time
      // too, for the first service).
      const params = await snapshotForHold(tx, service, at, now, inlineRelease);
      if (staffed[i] && people) {
        params.staff = await staffAvailability(
          tx,
          service,
          at,
          new Date(at.getTime() + 1),
          now,
          people,
        );
      }
      const slot =
        i === 0
          ? computeSlots(params).find((s) => s.startsAt.getTime() === at.getTime())
          : evaluateAt(params, at);
      // Capacity units this hold takes: its seats, or one booking.
      const units = service.capacityMode === "BOOKINGS" ? 1 : details.seats;
      if (!slot || slot.remaining < units) return { ok: false, reason: "unavailable" } as const;
      if (free && slot.staff) {
        const open = slot.staff;
        free = free.filter((id) => open.includes(id));
      }
    }
    if (free && !free.length) return { ok: false, reason: "unavailable" } as const;
    const staffId = free ? free[0] : null;

    const expiresAt = new Date(now.getTime() + items[0].service.holdTtlMinutes * 60_000);
    const holds: CreatedHold[] = items.map((item, i) => ({
      service: item.service,
      token: signHoldToken(randomBytes(16).toString("base64url"), secret),
      startsAt: starts[i],
      expiresAt,
    }));
    await tx.slotHold.createMany({
      data: holds.map((h, i) => {
        const { details } = items[i];
        return {
          serviceId: h.service.id,
          startsAt: h.startsAt,
          token: h.token,
          expiresAt,
          seats: details.seats,
          staffId: staffed[i] ? staffId : null,
          intakeAnswers: details.answers.length ? (details.answers as object[]) : undefined,
          signaturePng: details.signaturePng ? new Uint8Array(details.signaturePng) : undefined,
        };
      }),
    });
    const staff =
      staffId === null
        ? null
        : (items.flatMap((i) => i.service.staff).find((s) => s.id === staffId) ?? null);
    return { ok: true, holds, staff } as const;
  });
}

type SnapshotRow = {
  kind: "blackout" | "hold" | "booking";
  startsAt: Date;
  endsAt: Date | null;
  seats: number | null;
};

/**
 * What `buildSlotParams` reads for [startsAt, startsAt + 1ms), plus expiring
 * the customer's previous hold — in ONE statement. The database is remote, and
 * inside a transaction Prisma runs queries one after another, so the three
 * separate reads plus the release cost a round trip each.
 *
 * Postgres runs a data-modifying CTE even when nothing references it. Its
 * UPDATE isn't visible to the same statement's snapshot, though, so the
 * released hold is also excluded from the hold count explicitly.
 * Timestamps are compared as UTC `timestamp`, the way Prisma stores DateTime.
 */
async function snapshotForHold(
  tx: Prisma.TransactionClient,
  service: BookableService,
  startsAt: Date,
  now: Date,
  release: string | null,
): Promise<ComputeSlotsParams> {
  const rangeEnd = new Date(startsAt.getTime() + 1);
  // Same padding as buildSlotParams: buffers can reach past the range.
  const pad = 24 * 60 * 60_000;
  const utc = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  // PEOPLE mode counts seats; BOOKINGS mode counts rows.
  const units =
    service.capacityMode === "BOOKINGS" ? Prisma.sql`COUNT(*)::int` : Prisma.sql`SUM("seats")::int`;

  const rows = await tx.$queryRaw<SnapshotRow[]>`
    WITH released AS (
      UPDATE "SlotHold" SET "expiresAt" = ${utc(now)}
      WHERE ${release}::text IS NOT NULL
        AND "token" = ${release}
        AND "serviceId" = ${service.id}
        AND "consumedAt" IS NULL
      RETURNING 1
    )
    SELECT 'blackout' AS "kind", "startsAt", "endsAt", NULL::int AS "seats"
    FROM "Blackout"
    WHERE "shopId" = ${service.shopId}
      AND ("serviceId" IS NULL OR "serviceId" = ${service.id})
      AND "startsAt" < ${utc(new Date(rangeEnd.getTime() + pad))}
      AND "endsAt" > ${utc(new Date(startsAt.getTime() - pad))}
    UNION ALL
    SELECT 'hold', "startsAt", NULL, ${units}
    FROM "SlotHold"
    WHERE "serviceId" = ${service.id}
      AND "consumedAt" IS NULL
      AND "expiresAt" > ${utc(now)}
      AND "startsAt" >= ${utc(startsAt)} AND "startsAt" < ${utc(rangeEnd)}
      AND "token" IS DISTINCT FROM ${release}
    GROUP BY "startsAt"
    UNION ALL
    SELECT 'booking', "startsAt", NULL, ${units}
    FROM "Booking"
    WHERE "serviceId" = ${service.id}
      AND "status" = 'CONFIRMED'
      AND "startsAt" >= ${utc(startsAt)} AND "startsAt" < ${utc(rangeEnd)}
    GROUP BY "startsAt"
  `;

  const blackouts: Interval[] = [];
  const usage: SlotUsage[] = [];
  for (const r of rows) {
    if (r.kind === "blackout") blackouts.push({ startsAt: r.startsAt, endsAt: r.endsAt! });
    else usage.push({ startsAt: r.startsAt, count: r.seats ?? 0 });
  }

  return {
    service: service.geometry,
    windows: service.windows,
    blackouts,
    usage,
    overrides: service.overrides,
    rangeStart: startsAt,
    rangeEnd,
    now,
  };
}
