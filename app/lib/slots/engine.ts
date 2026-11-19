import { DateTime } from "luxon";

import type {
  CapacityOverride,
  ComputeSlotsParams,
  Interval,
  ServiceGeometry,
  Slot,
  SlotUsage,
  StaffAvailability,
  StaffSchedule,
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

/**
 * Staff (in `staff.ids` order) free for an appointment: nothing booked
 * overlapping `span` (the appointment with its buffers) and on duty for all
 * of `appointment` itself (buffers may fall outside their hours, as they may
 * outside the service's). Null when the service has no staff step, so
 * callers can tell "no staff" from "no one free".
 */
export function staffFreeAt(
  staff: StaffAvailability | undefined,
  span: Interval,
  appointment: Interval = span,
): string[] | null {
  if (!staff || !staff.ids.length) return null;
  return staff.ids.filter(
    (id) =>
      !(staff.busy[id] ?? []).some((b) => overlaps(span, b)) &&
      !(staff.off?.[id] ?? []).some((b) => overlaps(appointment, b)),
  );
}

/**
 * "Any available": of the people `free`, the one with the fewest holds and
 * bookings (`staff.busy`) starting on `at`'s local day, so work spreads
 * evenly. Ties keep the merchant's order (the first free person).
 */
export function leastBusy(
  free: string[],
  staff: StaffAvailability | undefined,
  at: Date,
  zone: string,
): string {
  if (free.length < 2 || !staff) return free[0];
  const day = DateTime.fromJSDate(at, { zone });
  const from = day.startOf("day").toMillis();
  const to = day.plus({ days: 1 }).startOf("day").toMillis();
  const load = (id: string) =>
    (staff.busy[id] ?? []).filter((b) => {
      const t = b.startsAt.getTime();
      return t >= from && t < to;
    }).length;
  let best = free[0];
  let bestLoad = load(best);
  for (const id of free.slice(1)) {
    const l = load(id);
    if (l < bestLoad) {
      best = id;
      bestLoad = l;
    }
  }
  return best;
}

/**
 * When a staff member is NOT working within [from, to): the time outside
 * their weekly `hours` (a day without hours is off entirely) plus whole days
 * off, as UTC intervals. `hours` null means "the service's hours": only the
 * days off then. Local days in `zone`, so DST shifts are followed.
 */
export function staffOffDuty(
  schedule: StaffSchedule,
  zone: string,
  from: Date,
  to: Date,
): Interval[] {
  const { hours, daysOff } = schedule;
  if (!hours && !daysOff.length) return [];
  const off = new Set(daysOff);
  const out: Interval[] = [];
  const first = DateTime.fromJSDate(from, { zone }).startOf("day");
  const last = DateTime.fromJSDate(to, { zone }).startOf("day");
  for (let day = first; day <= last; day = day.plus({ days: 1 })) {
    const dayStart = day.toJSDate();
    const dayEnd = day.plus({ days: 1 }).startOf("day").toJSDate();
    if (off.has(day.toFormat("yyyy-MM-dd"))) {
      out.push({ startsAt: dayStart, endsAt: dayEnd });
      continue;
    }
    if (!hours) continue;
    const dayOfWeek = day.weekday % 7;
    const windows = hours
      .filter((h) => h.dayOfWeek === dayOfWeek && h.endMinute > h.startMinute)
      .sort((a, b) => a.startMinute - b.startMinute);
    // The gaps between the working windows, from midnight to midnight.
    let cursor = dayStart;
    for (const w of windows) {
      const start = localToUtc(day, w.startMinute) ?? dayStart;
      const end = localToUtc(day, w.endMinute) ?? dayEnd;
      if (start > cursor) out.push({ startsAt: cursor, endsAt: start });
      if (end > cursor) cursor = end;
    }
    if (cursor < dayEnd) out.push({ startsAt: cursor, endsAt: dayEnd });
  }
  return out;
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
  staff,
  rangeStart,
  rangeEnd,
  now,
  includeFull = false,
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
        // A 0 limit closes the slot: never offered, not even as booked out.
        if (capacity <= 0) continue;
        const remaining = capacity - (usageMap.get(key) ?? 0);
        // Staff serve a whole booking, whatever its party size: no one free
        // makes the slot full, but free staff don't cap the seats left.
        const free = staffFreeAt(staff, blocked, { startsAt, endsAt });
        const full = remaining <= 0 || remaining < minUnits || (free !== null && !free.length);
        if (full && !includeFull) continue;

        seen.add(key);
        const slot: Slot = { startsAt, endsAt, capacity, remaining: full ? 0 : remaining };
        if (free) slot.staff = free;
        slots.push(slot);
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
  return groupByDay(computeSlots(params), params.service.timezone);
}

/** Sorted slots grouped by local date in `zone`, each day kept in order. */
export function groupByDay(slots: Slot[], zone: string): Record<string, Slot[]> {
  const byDay: Record<string, Slot[]> = {};
  for (const slot of slots) {
    const day = DateTime.fromJSDate(slot.startsAt, { zone }).toFormat("yyyy-MM-dd");
    (byDay[day] ??= []).push(slot);
  }
  return byDay;
}

/**
 * The service as it stands at exactly `startsAt`, off the slot grid: inside
 * an opening window (appointment fits), clear of blackouts, limit above 0,
 * with its remaining capacity and free staff. Null when it isn't open then.
 * Lead time and booking horizon are NOT checked: a combined service starts
 * after the first one, which already passed them.
 */
export function evaluateAt(
  params: Pick<ComputeSlotsParams, "service" | "windows" | "blackouts" | "usage" | "overrides" | "staff">,
  startsAt: Date,
): Slot | null {
  const { service } = params;
  if (service.durationMinutes <= 0) return null;
  const local = DateTime.fromJSDate(startsAt, { zone: service.timezone });
  const minute = local.hour * 60 + local.minute;
  const dayOfWeek = local.weekday % 7;
  const window = params.windows.find(
    (w) =>
      w.dayOfWeek === dayOfWeek &&
      minute >= w.startMinute &&
      minute + service.durationMinutes <= w.endMinute,
  );
  if (!window) return null;

  const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);
  const blocked: Interval = {
    startsAt: new Date(startsAt.getTime() - service.bufferBeforeMinutes * 60_000),
    endsAt: new Date(endsAt.getTime() + service.bufferAfterMinutes * 60_000),
  };
  if (params.blackouts.some((b) => overlaps(blocked, b))) return null;

  const capacity = capacityAt(
    service,
    window,
    params.overrides,
    local.toFormat("yyyy-MM-dd"),
    minute,
  );
  if (capacity <= 0) return null;
  const used = params.usage
    .filter((u) => u.startsAt.getTime() === startsAt.getTime())
    .reduce((sum, u) => sum + u.count, 0);
  const remaining = capacity - used;
  const minUnits = Math.max(1, service.minUnitsPerHold ?? 1);
  const free = staffFreeAt(params.staff, blocked, { startsAt, endsAt });
  const full = remaining < minUnits || (free !== null && !free.length);
  const slot: Slot = { startsAt, endsAt, capacity, remaining: full ? 0 : remaining };
  if (free) slot.staff = free;
  return slot;
}

/**
 * Start times of services booked back to back from `startsAt`: each begins
 * when the one before it ends, plus that one's after-buffer and its own
 * before-buffer, so the chain never collides with itself.
 */
export function chainStarts(
  services: Pick<ServiceGeometry, "durationMinutes" | "bufferBeforeMinutes" | "bufferAfterMinutes">[],
  startsAt: Date,
): Date[] {
  const out: Date[] = [];
  let at = startsAt.getTime();
  services.forEach((s, i) => {
    if (i > 0) {
      const prev = services[i - 1];
      at += (prev.durationMinutes + prev.bufferAfterMinutes + s.bufferBeforeMinutes) * 60_000;
    }
    out.push(new Date(at));
  });
  return out;
}

/** Minutes from the chain's first start to the end of its last service. */
export function chainMinutes(
  services: Pick<ServiceGeometry, "durationMinutes" | "bufferBeforeMinutes" | "bufferAfterMinutes">[],
): number {
  if (!services.length) return 0;
  const starts = chainStarts(services, new Date(0));
  return starts[starts.length - 1].getTime() / 60_000 + services[services.length - 1].durationMinutes;
}

/**
 * Slots for several services booked back to back, the first one's params
 * deciding the candidate starts (its grid, lead time, horizon, range). A
 * start is offered only when every later service is open at its own start;
 * `remaining` is the smallest left across the chain (display only — each
 * hold re-checks its own service), and `staff` the people free for every
 * service that has staff. One person does the whole chain.
 */
export function comboSlots(chain: ComputeSlotsParams[]): Slot[] {
  if (!chain.length) return [];
  const [first, ...rest] = chain;
  if (!rest.length) return computeSlots(first);
  const geometry = chain.map((c) => c.service);
  const out: Slot[] = [];

  for (const head of computeSlots(first)) {
    const starts = chainStarts(geometry, head.startsAt);
    let remaining = head.remaining;
    let capacity = head.capacity;
    let staff = head.staff;
    let endsAt = head.endsAt;
    let open = true;
    for (let i = 0; i < rest.length; i++) {
      const s = evaluateAt(rest[i], starts[i + 1]);
      if (!s) {
        open = false;
        break;
      }
      remaining = Math.min(remaining, s.remaining);
      capacity = Math.min(capacity, s.capacity);
      if (s.staff) staff = staff ? staff.filter((id) => s.staff!.includes(id)) : s.staff;
      endsAt = s.endsAt;
    }
    if (!open) continue;
    if (staff && !staff.length) remaining = 0;
    if (remaining <= 0 && !first.includeFull) continue;
    const slot: Slot = { startsAt: head.startsAt, endsAt, capacity, remaining: Math.max(0, remaining) };
    if (staff) slot.staff = staff;
    out.push(slot);
  }
  return out;
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
