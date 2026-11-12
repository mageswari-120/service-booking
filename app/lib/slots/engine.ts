import { DateTime } from "luxon";

import type {
  CapacityOverride,
  ComputeSlotsParams,
  Interval,
  ServiceGeometry,
  Slot,
  SlotUsage,
  WeeklyWindow,
} from "./types";

const MINUTES_PER_DAY = 1440;

/**
 * Minutes a booking starting at `startMinute` occupies, including buffers.
 * Buffers pad the booking for conflict purposes but do NOT have to fit inside
 * the opening window — see README.md for why.
 */
function bufferedSpan(
  startMinute: number,
  service: ServiceGeometry,
): { from: number; to: number } {
  return {
    from: startMinute - service.bufferBeforeMinutes,
    to: startMinute + service.durationMinutes + service.bufferAfterMinutes,
  };
}

function step(service: ServiceGeometry): number {
  const raw = service.slotIntervalMinutes ?? service.durationMinutes;
  return raw > 0 ? raw : service.durationMinutes;
}

/**
 * Convert a local wall-clock time to a UTC instant.
 *
 * Returns null when that wall time does not exist in the zone — the spring
 * forward gap. Luxon silently shifts such times onto the next valid instant,
 * which would otherwise invent a slot the merchant never opened, so we compare
 * the round-tripped wall time and reject a mismatch.
 *
 * Ambiguous times (the autumn fall-back hour, which happens twice) resolve to
 * the first/earlier offset, which is Luxon's default and the conventional
 * choice for scheduling.
 */
function localToUtc(day: DateTime, minuteOfDay: number): Date | null {
  const dayOffset = Math.floor(minuteOfDay / MINUTES_PER_DAY);
  const withinDay = minuteOfDay - dayOffset * MINUTES_PER_DAY;

  const target = day
    .plus({ days: dayOffset })
    .startOf("day")
    .set({
      hour: Math.floor(withinDay / 60),
      minute: withinDay % 60,
      second: 0,
      millisecond: 0,
    });

  if (!target.isValid) return null;

  // Luxon normalizes a nonexistent wall time by shifting it forward, so if the
  // wall time we get back is not the one we asked for, the slot never existed.
  if (target.hour * 60 + target.minute !== withinDay) {
    return null; // nonexistent local time (DST gap)
  }

  return target.toJSDate();
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

function usageKey(d: Date): number {
  return d.getTime();
}

function buildUsageMap(usage: SlotUsage[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const entry of usage) {
    const key = usageKey(entry.startsAt);
    map.set(key, (map.get(key) ?? 0) + entry.count);
  }
  return map;
}

/**
 * The limit for a slot starting `minute` minutes after local midnight on
 * `localDate` ("YYYY-MM-DD"). Most specific wins: a date override (whole day,
 * or a minute range containing the start), then the weekly window's own
 * limit, then the service default.
 */
export function capacityAt(
  service: Pick<ServiceGeometry, "capacityPerSlot">,
  window: Pick<WeeklyWindow, "capacity"> | undefined,
  overrides: CapacityOverride[] | undefined,
  localDate: string,
  minute: number,
): number {
  for (const o of overrides ?? []) {
    if (o.date !== localDate) continue;
    const from = o.startMinute ?? 0;
    const to = o.endMinute ?? MINUTES_PER_DAY;
    if (minute >= from && minute < to) return o.capacity;
  }
  return window?.capacity ?? service.capacityPerSlot;
}

/**
 * The limit for the slot starting at `startsAt`, without re-checking lead
 * time or opening hours. The orders webhook uses this when a hold lapsed
 * during checkout: the slot may now be inside the minimum notice, but the
 * customer still picked it when it was offered.
 */
export function slotCapacity(
  params: {
    service: Pick<ServiceGeometry, "capacityPerSlot" | "timezone">;
    windows: WeeklyWindow[];
    overrides?: CapacityOverride[];
  },
  startsAt: Date,
): number {
  const local = DateTime.fromJSDate(startsAt, { zone: params.service.timezone });
  const minute = local.hour * 60 + local.minute;
  const dayOfWeek = local.weekday % 7;
  const window = params.windows.find(
    (w) => w.dayOfWeek === dayOfWeek && minute >= w.startMinute && minute < w.endMinute,
  );
  return capacityAt(
    params.service,
    window,
    params.overrides,
    local.toFormat("yyyy-MM-dd"),
    minute,
  );
}

/**
 * Compute every bookable slot in [rangeStart, rangeEnd).
 *
 * Pure: no I/O, no clock reads. `now` is injected so tests and the proxy agree.
 * Results are sorted ascending and de-duplicated, so overlapping availability
 * windows on the same day cannot yield the same start twice.
 */
export function computeSlots({
  service,
  windows,
  blackouts,
  usage,
  overrides,
  rangeStart,
  rangeEnd,
  now,
}: ComputeSlotsParams): Slot[] {
  if (service.durationMinutes <= 0) return [];
  if (windows.length === 0) return [];
  const minUnits = Math.max(1, service.minUnitsPerHold ?? 1);

  const zone = service.timezone;
  const usageMap = buildUsageMap(usage);
  const increment = step(service);

  const earliest = new Date(now.getTime() + service.leadTimeMinutes * 60_000);
  const latest = new Date(
    now.getTime() + service.maxAdvanceDays * MINUTES_PER_DAY * 60_000,
  );

  // Walk local calendar days. Pad by one day each side so a window that
  // straddles midnight in the local zone is not clipped by the UTC bounds.
  const firstDay = DateTime.fromJSDate(rangeStart, { zone })
    .startOf("day")
    .minus({ days: 1 });
  const lastDay = DateTime.fromJSDate(rangeEnd, { zone })
    .startOf("day")
    .plus({ days: 1 });

  const windowsByDay = new Map<number, typeof windows>();
  for (const w of windows) {
    const list = windowsByDay.get(w.dayOfWeek) ?? [];
    list.push(w);
    windowsByDay.set(w.dayOfWeek, list);
  }

  const seen = new Set<number>();
  const slots: Slot[] = [];

  for (let day = firstDay; day <= lastDay; day = day.plus({ days: 1 })) {
    // Luxon weekday is 1=Monday..7=Sunday; our dayOfWeek is 0=Sunday..6=Saturday.
    const dayOfWeek = day.weekday % 7;
    const dayWindows = windowsByDay.get(dayOfWeek);
    if (!dayWindows) continue;
    const localDate = day.toFormat("yyyy-MM-dd");

    for (const window of dayWindows) {
      if (window.endMinute <= window.startMinute) continue;

      for (
        let minute = window.startMinute;
        // The appointment itself must fit the window; buffers may spill past it.
        minute + service.durationMinutes <= window.endMinute;
        minute += increment
      ) {
        const startsAt = localToUtc(day, minute);
        if (!startsAt) continue;

        if (startsAt < rangeStart || startsAt >= rangeEnd) continue;
        if (startsAt < earliest || startsAt > latest) continue;

        const key = usageKey(startsAt);
        if (seen.has(key)) continue;

        const endsAt = new Date(
          startsAt.getTime() + service.durationMinutes * 60_000,
        );

        const span = bufferedSpan(minute, service);
        const blockFrom = localToUtc(day, span.from);
        const blockTo = localToUtc(day, span.to);
        const blocked: Interval = {
          startsAt: blockFrom ?? startsAt,
          endsAt: blockTo ?? endsAt,
        };

        if (blackouts.some((b) => overlaps(blocked, b))) continue;

        const capacity = capacityAt(service, window, overrides, localDate, minute);
        const remaining = capacity - (usageMap.get(key) ?? 0);
        if (remaining <= 0 || remaining < minUnits) continue;

        seen.add(key);
        slots.push({ startsAt, endsAt, capacity, remaining });
      }
    }
  }

  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return slots;
}

/**
 * Bookable slots grouped by local calendar date ("YYYY-MM-DD", service
 * timezone), each day in time order. Only days with at least one slot appear.
 * Backs the month view, which ships a month's times in one response so the
 * storefront can switch days without another request.
 */
export function slotsByDay(params: ComputeSlotsParams): Record<string, Slot[]> {
  const zone = params.service.timezone;
  const byDay: Record<string, Slot[]> = {};
  // computeSlots returns slots sorted by start, so each day stays in order.
  for (const slot of computeSlots(params)) {
    const day = DateTime.fromJSDate(slot.startsAt, { zone }).toFormat("yyyy-MM-dd");
    (byDay[day] ??= []).push(slot);
  }
  return byDay;
}

/** Local calendar dates ("YYYY-MM-DD", service timezone) with at least one slot. */
export function bookableDays(params: ComputeSlotsParams): string[] {
  return Object.keys(slotsByDay(params)).sort();
}

/**
 * True when `startsAt` is a slot this service genuinely offers. The orders
 * webhook re-checks the customer-supplied instant through this rather than
 * trusting the line item property.
 */
export function isOfferedSlot(
  params: Omit<ComputeSlotsParams, "rangeStart" | "rangeEnd">,
  startsAt: Date,
): boolean {
  const slots = computeSlots({
    ...params,
    rangeStart: new Date(startsAt.getTime() - 1),
    rangeEnd: new Date(startsAt.getTime() + 1),
  });
  return slots.some((s) => s.startsAt.getTime() === startsAt.getTime());
}
