import { DateTime } from "luxon";

import { comboSlots, groupByDay } from "../slots/engine";
import type { ComputeSlotsParams, Slot } from "../slots/types";
import {
  buildSlotParams,
  buildSlotParamsMany,
  type BookableService,
} from "./context.server";

export interface MonthSlot {
  start: string;
  capacity: number;
  remaining: number;
  /** Staff ids free at this time, when the service has staff. */
  staff?: string[];
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
  return shapeSlots(
    range,
    params ? comboSlots([{ ...params, includeFull: true }]) : [],
    params?.service.timezone ?? "UTC",
  );
}

function shapeSlots(range: Range, list: Slot[], zone: string): MonthSlots {
  const byDay = groupByDay(list, zone);
  const days = Object.keys(byDay)
    .filter((day) => byDay[day].some((s) => s.remaining > 0))
    .sort();
  // `end` is left out: the widget only needs the start, and a month of short
  // slots adds up.
  const slots = Object.fromEntries(
    Object.keys(byDay).map((day) => [
      day,
      byDay[day].map((s): MonthSlot => {
        const out: MonthSlot = {
          start: s.startsAt.toISOString(),
          capacity: s.capacity,
          remaining: s.remaining,
        };
        if (s.staff) out.staff = s.staff;
        return out;
      }),
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
 * A month of start times for `service` followed back to back by `rest` (the
 * popup's combined services). Each later service is read over the same
 * range, padded by a day: the chain can run past midnight or the month end.
 */
export async function monthComboSlots(
  service: BookableService,
  rest: BookableService[],
  monthParam: string | null,
  now: Date = new Date(),
): Promise<MonthSlots> {
  if (!rest.length) return monthSlots(service, monthParam, now);
  const range = monthRange(service, monthParam, now);
  if (range.from >= range.to) return shapeSlots(range, [], service.geometry.timezone);
  const from = range.from.toJSDate();
  const to = range.to.toJSDate();
  const pad = 24 * 60 * 60_000;
  const chain = await Promise.all([
    buildSlotParams(service, from, to, now),
    ...rest.map((s) =>
      buildSlotParams(s, from, new Date(to.getTime() + pad), now),
    ),
  ]);
  chain[0] = { ...chain[0], includeFull: true };
  return shapeSlots(range, comboSlots(chain), service.geometry.timezone);
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
