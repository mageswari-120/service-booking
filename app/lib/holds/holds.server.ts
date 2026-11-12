import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";

import db from "../../db.server";
import type { BookableService } from "../booking/context.server";
import type { IntakeAnswer } from "../booking/details";
import { computeSlots } from "../slots/engine";
import type { ComputeSlotsParams, Interval, SlotUsage } from "../slots/types";
import { holdSecret, signHoldToken, verifyHoldToken } from "./token";

export type HoldResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: "unavailable" };

/**
 * Reserve `details.seats` seats at `startsAt` for `service.holdTtlMinutes`.
 *
 * This is the authoritative capacity check — the slot list the customer saw is
 * already stale. Concurrent requests for the same slot are serialised with a
 * transaction-scoped Postgres advisory lock keyed on (service, start), so two
 * customers cannot both take the last seat. Different slots don't contend.
 *
 * `releaseToken` is the customer's previous hold, if they're changing time;
 * it is expired in the same transaction so they never hold two seats.
 *
 * `details` (already validated by validateHoldDetails) is stored on the hold
 * for the orders handler: how many seats, the intake answers and signature.
 */
export async function createHold(
  service: BookableService,
  startsAt: Date,
  releaseToken: string | null,
  details: { seats: number; answers: IntakeAnswer[]; signaturePng: Buffer | null } = {
    seats: 1,
    answers: [],
    signaturePng: null,
  },
  now: Date = new Date(),
): Promise<HoldResult> {
  const secret = holdSecret();

  return db.$transaction(async (tx) => {
    const lockKey = `${service.id}|${startsAt.toISOString()}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const release =
      releaseToken && verifyHoldToken(releaseToken, secret) ? releaseToken : null;

    // Re-run the engine for exactly this instant against fresh usage, so lead
    // time, opening hours, blackouts and capacity are all re-checked.
    const params = await snapshotForHold(tx, service, startsAt, now, release);
    // Capacity units this hold takes: its seats, or one booking.
    const units = service.capacityMode === "BOOKINGS" ? 1 : details.seats;
    const offered = computeSlots(params).some(
      (s) => s.startsAt.getTime() === startsAt.getTime() && s.remaining >= units,
    );
    if (!offered) return { ok: false, reason: "unavailable" } as const;

    const token = signHoldToken(randomBytes(16).toString("base64url"), secret);
    const expiresAt = new Date(now.getTime() + service.holdTtlMinutes * 60_000);
    await tx.slotHold.create({
      data: {
        serviceId: service.id,
        startsAt,
        token,
        expiresAt,
        seats: details.seats,
        intakeAnswers: details.answers.length ? (details.answers as object[]) : undefined,
        signaturePng: details.signaturePng ? new Uint8Array(details.signaturePng) : undefined,
      },
    });
    return { ok: true, token, expiresAt } as const;
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
