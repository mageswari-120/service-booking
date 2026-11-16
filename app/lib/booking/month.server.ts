import { DateTime } from "luxon";

import { slotsByDay } from "../slots/engine";
import type { ComputeSlotsParams } from "../slots/types";
import {
  buildSlotParams,
  buildSlotParamsMany,
  type BookableService,
} from "./context.server";

export interface MonthSlot {
  start: string;
  capacity: number;
  remaining: number;
}

export interface MonthSlots {
  /** The month scanned, "YYYY-MM" in the service's timezone. */
  month: string;
  /** Bounds for the storefront's prev/next buttons. */
  firstMonth: string;
  lastMonth: string;
  /** Days with at least one slot that can still be booked. */
  days: string[];
  /**
   * Every day the engine produced, booked-out slots included (remaining 0):
   * the storefront tells "sold out" apart from "never open" with them.
   */
  slots: Record<string, MonthSlot[]>;
}

/**
 * The month to scan (`monthParam` "YYYY-MM"; invalid or missing means the
 * current month) clamped to what can be booked: from now to the service's
 * booking horizon. `from >= to` means nothing in it can be booked.
 */
function monthRange(service: BookableService, monthParam: string | null, now: Date) {
  const zone = service.geometry.timezone;
  const nowLocal = DateTime.fromJSDate(now, { zone });
  const lastLocal = nowLocal.plus({ days: service.geometry.maxAdvanceDays });
  const requested = DateTime.fromFormat(monthParam ?? "", "yyyy-MM", { zone });
  const month = requested.isValid ? requested : nowLocal.startOf("month");
  return {
    month: month.toFormat("yyyy-MM"),
    firstMonth: nowLocal.toFormat("yyyy-MM"),
    lastMonth: lastLocal.toFormat("yyyy-MM"),
    from: DateTime.max(month.startOf("month"), nowLocal),
    to: DateTime.min(month.endOf("month"), lastLocal),
  };
}

type Range = ReturnType<typeof monthRange>;

function shapeMonth(range: Range, params: ComputeSlotsParams | null): MonthSlots {
  const byDay = params ? slotsByDay({ ...params, includeFull: true }) : {};
  const days = Object.keys(byDay)
    .filter((day) => byDay[day].some((s) => s.remaining > 0))
    .sort();
  // `end` is left out: the widget only needs the start, and a month of short
  // slots adds up.
  const slots = Object.fromEntries(
    Object.keys(byDay).map((day) => [
      day,
      byDay[day].map((s) => ({
        start: s.startsAt.toISOString(),
        capacity: s.capacity,
        remaining: s.remaining,
      })),
    ]),
  );
  return {
    month: range.month,
    firstMonth: range.firstMonth,
    lastMonth: range.lastMonth,
    days,
    slots,
  };
}

/** One service's slots for a month (the product popup's /availability). */
export async function monthSlots(
  service: BookableService,
  monthParam: string | null,
  now: Date = new Date(),
): Promise<MonthSlots> {
  const range = monthRange(service, monthParam, now);
  const params =
    range.from < range.to
      ? await buildSlotParams(service, range.from.toJSDate(), range.to.toJSDate(), now)
      : null;
  return shapeMonth(range, params);
}

/**
 * Many services' slots for a month (the storefront calendar), with one set of
 * database reads for all of them. Results are in the order of `services`.
 */
export async function monthSlotsMany(
  services: BookableService[],
  monthParam: string | null,
  now: Date = new Date(),
): Promise<MonthSlots[]> {
  const ranges = services.map((service) => monthRange(service, monthParam, now));
  const open = services
    .map((service, i) => ({ service, i, range: ranges[i] }))
    .filter(({ range }) => range.from < range.to);
  const params = await buildSlotParamsMany(
    open.map(({ service, range }) => ({
      service,
      rangeStart: range.from.toJSDate(),
      rangeEnd: range.to.toJSDate(),
    })),
    now,
  );
  const byIndex = new Map(open.map(({ i }, n) => [i, params[n]]));
  return ranges.map((range, i) => shapeMonth(range, byIndex.get(i) ?? null));
}
