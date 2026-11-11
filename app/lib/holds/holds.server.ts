import { randomBytes } from "node:crypto";

import db from "../../db.server";
import { buildSlotParams, type BookableService } from "../booking/context.server";
import type { IntakeAnswer } from "../booking/details";
import { computeSlots } from "../slots/engine";
import { holdSecret, signHoldToken, verifyHoldToken } from "./token";

export type HoldResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: "unavailable" };

/**
 * Reserve one seat at `startsAt` for `service.holdTtlMinutes`.
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

    if (releaseToken && verifyHoldToken(releaseToken, secret)) {
      await tx.slotHold.updateMany({
        where: { token: releaseToken, serviceId: service.id, consumedAt: null },
        data: { expiresAt: now },
      });
    }

    // Re-run the engine for exactly this instant against fresh usage, so lead
    // time, opening hours, blackouts and capacity are all re-checked.
    const params = await buildSlotParams(
      service,
      startsAt,
      new Date(startsAt.getTime() + 1),
      now,
      tx,
    );
    const offered = computeSlots(params).some(
      (s) => s.startsAt.getTime() === startsAt.getTime() && s.remaining >= details.seats,
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
