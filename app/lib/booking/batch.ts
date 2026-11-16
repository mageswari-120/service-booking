import type { CapacityMode } from "@prisma/client";

import type { Interval, SlotUsage } from "../slots/types";

/** A hold or booking groupBy row, grouped by service and start. */
export interface UsageRow {
  serviceId: string;
  startsAt: Date;
  _sum: { seats: number | null };
  _count: { _all: number };
}

/** A blackout; `serviceId` null means it closes the whole shop. */
export interface BlackoutRow {
  serviceId: string | null;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Split rows read once for many services into each service's blackouts and
 * slot usage. Shop-wide blackouts go to every service. PEOPLE mode counts
 * seats (one hold or booking can be several people); BOOKINGS mode counts rows.
 */
export function splitByService(
  services: { id: string; capacityMode: CapacityMode }[],
  blackouts: BlackoutRow[],
  holds: UsageRow[],
  bookings: UsageRow[],
): Map<string, { blackouts: Interval[]; usage: SlotUsage[] }> {
  const out = new Map<string, { blackouts: Interval[]; usage: SlotUsage[] }>();
  const modes = new Map<string, CapacityMode>();
  for (const s of services) {
    out.set(s.id, { blackouts: [], usage: [] });
    modes.set(s.id, s.capacityMode);
  }

  for (const b of blackouts) {
    const interval = { startsAt: b.startsAt, endsAt: b.endsAt };
    if (b.serviceId === null) out.forEach((v) => v.blackouts.push(interval));
    else out.get(b.serviceId)?.blackouts.push(interval);
  }

  for (const r of [...holds, ...bookings]) {
    const target = out.get(r.serviceId);
    if (!target) continue;
    const count = modes.get(r.serviceId) === "BOOKINGS" ? r._count._all : (r._sum.seats ?? 0);
    target.usage.push({ startsAt: r.startsAt, count });
  }
  return out;
}
