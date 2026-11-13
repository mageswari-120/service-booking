import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import { bookableDays, computeSlots, isOfferedSlot, slotCapacity, slotsByDay } from "./engine";
import type { ComputeSlotsParams, ServiceGeometry } from "./types";

const NY = "America/New_York";
const IST = "Asia/Kolkata";

function geometry(over: Partial<ServiceGeometry> = {}): ServiceGeometry {
  return {
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    slotIntervalMinutes: null,
    leadTimeMinutes: 0,
    maxAdvanceDays: 365,
    capacityPerSlot: 1,
    timezone: NY,
    ...over,
  };
}

/** Local wall time in a zone -> UTC Date. Test-side mirror of the engine. */
function at(zone: string, iso: string): Date {
  const dt = DateTime.fromISO(iso, { zone });
  if (!dt.isValid) throw new Error(`bad test date: ${iso} (${dt.invalidReason})`);
  return dt.toJSDate();
}

/** The whole local calendar day as a UTC range. */
function dayRange(zone: string, date: string) {
  const start = DateTime.fromISO(date, { zone }).startOf("day");
  return { rangeStart: start.toJSDate(), rangeEnd: start.plus({ days: 1 }).toJSDate() };
}

function params(over: Partial<ComputeSlotsParams> = {}): ComputeSlotsParams {
  return {
    service: geometry(),
    windows: [],
    blackouts: [],
    usage: [],
    rangeStart: new Date("2027-06-01T00:00:00Z"),
    rangeEnd: new Date("2027-06-02T00:00:00Z"),
    now: new Date("2027-01-01T00:00:00Z"),
    ...over,
  };
}

/** Slot starts rendered as local wall times, for readable assertions. */
function localTimes(slots: { startsAt: Date }[], zone: string): string[] {
  return slots.map((s) => DateTime.fromJSDate(s.startsAt, { zone }).toFormat("HH:mm"));
}

const h = (hour: number, minute = 0) => hour * 60 + minute;

describe("computeSlots — basics", () => {
  it("steps by duration when no interval is set", () => {
    // 2027-06-01 is a Tuesday (dayOfWeek 2).
    const slots = computeSlots(
      params({
        service: geometry({ durationMinutes: 60 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(12) }],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(localTimes(slots, NY)).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("steps by slotIntervalMinutes when set, allowing overlap-free staggering", () => {
    const slots = computeSlots(
      params({
        service: geometry({ durationMinutes: 60, slotIntervalMinutes: 30 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(11) }],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(localTimes(slots, NY)).toEqual(["09:00", "09:30", "10:00"]);
  });

  it("returns nothing when there are no availability windows", () => {
    expect(computeSlots(params({ windows: [] }))).toEqual([]);
  });

  it("ignores a window whose end is at or before its start", () => {
    const slots = computeSlots(
      params({
        windows: [{ dayOfWeek: 2, startMinute: h(12), endMinute: h(12) }],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(slots).toEqual([]);
  });

  it("de-duplicates a start produced by two overlapping windows", () => {
    const slots = computeSlots(
      params({
        windows: [
          { dayOfWeek: 2, startMinute: h(9), endMinute: h(11) },
          { dayOfWeek: 2, startMinute: h(9), endMinute: h(10) },
        ],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(localTimes(slots, NY)).toEqual(["09:00", "10:00"]);
  });

  it("only emits slots for the matching weekday", () => {
    // Window on Sunday (0); the queried day is a Tuesday.
    const slots = computeSlots(
      params({
        windows: [{ dayOfWeek: 0, startMinute: h(9), endMinute: h(12) }],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(slots).toEqual([]);
  });
});

describe("computeSlots — window fit", () => {
  it("drops a trailing partial slot when duration does not divide the window", () => {
    // 9:00-10:40 with 45m slots: 9:00 and 9:45 fit, 10:30 would end at 11:15.
    const slots = computeSlots(
      params({
        service: geometry({ durationMinutes: 45 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(10, 40) }],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(localTimes(slots, NY)).toEqual(["09:00", "09:45"]);
  });

  it("lets a trailing buffer spill past the window edge (documented rule)", () => {
    // The appointment fits 9:00-10:00 exactly; the 15m buffer runs to 10:15.
    const slots = computeSlots(
      params({
        service: geometry({ durationMinutes: 60, bufferAfterMinutes: 15 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(10) }],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(localTimes(slots, NY)).toEqual(["09:00"]);
  });

  it("lets a leading buffer spill before the window edge", () => {
    const slots = computeSlots(
      params({
        service: geometry({ durationMinutes: 60, bufferBeforeMinutes: 30 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(10) }],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(localTimes(slots, NY)).toEqual(["09:00"]);
  });
});

describe("computeSlots — blackouts", () => {
  it("removes a slot a blackout only partially overlaps", () => {
    const slots = computeSlots(
      params({
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(12) }],
        blackouts: [
          { startsAt: at(NY, "2027-06-01T10:30"), endsAt: at(NY, "2027-06-01T10:45") },
        ],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    // Kills 10:00-11:00 only; 9:00 and 11:00 survive untouched.
    expect(localTimes(slots, NY)).toEqual(["09:00", "11:00"]);
  });

  it("does not remove a slot a blackout merely abuts", () => {
    // Blackout 10:00-10:30 touches the 9:00-10:00 slot's end. Half-open
    // intervals must not treat that as an overlap.
    const slots = computeSlots(
      params({
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(10) }],
        blackouts: [
          { startsAt: at(NY, "2027-06-01T10:00"), endsAt: at(NY, "2027-06-01T10:30") },
        ],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(localTimes(slots, NY)).toEqual(["09:00"]);
  });

  it("removes a slot whose buffer — not the appointment — hits the blackout", () => {
    // Appointment 9:00-10:00 is clear; the trailing buffer to 10:15 is not.
    const slots = computeSlots(
      params({
        service: geometry({ durationMinutes: 60, bufferAfterMinutes: 15 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(10) }],
        blackouts: [
          { startsAt: at(NY, "2027-06-01T10:05"), endsAt: at(NY, "2027-06-01T10:10") },
        ],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(slots).toEqual([]);
  });
});

describe("computeSlots — lead time and advance window", () => {
  it("excludes slots inside the lead time", () => {
    const slots = computeSlots(
      params({
        service: geometry({ leadTimeMinutes: 120 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(12) }],
        now: at(NY, "2027-06-01T08:00"), // earliest bookable start is 10:00
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(localTimes(slots, NY)).toEqual(["10:00", "11:00"]);
  });

  it("excludes slots beyond maxAdvanceDays", () => {
    const slots = computeSlots(
      params({
        service: geometry({ maxAdvanceDays: 1 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(10) }],
        now: at(NY, "2027-05-20T00:00"),
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(slots).toEqual([]);
  });
});

describe("computeSlots — capacity", () => {
  it("reports remaining capacity and keeps partially-used slots", () => {
    const nine = at(NY, "2027-06-01T09:00");
    const slots = computeSlots(
      params({
        service: geometry({ capacityPerSlot: 3 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(10) }],
        usage: [{ startsAt: nine, count: 2 }],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(slots).toHaveLength(1);
    expect(slots[0].remaining).toBe(1);
  });

  it("drops a slot once usage reaches capacity", () => {
    const nine = at(NY, "2027-06-01T09:00");
    const slots = computeSlots(
      params({
        service: geometry({ capacityPerSlot: 2 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(10) }],
        usage: [
          { startsAt: nine, count: 1 },
          { startsAt: nine, count: 1 },
        ],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(slots).toEqual([]);
  });

  it("keeps a full slot as remaining 0 with includeFull, for display", () => {
    const nine = at(NY, "2027-06-01T09:00");
    const slots = computeSlots(
      params({
        service: geometry({ capacityPerSlot: 2 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(11) }],
        usage: [{ startsAt: nine, count: 2 }],
        ...dayRange(NY, "2027-06-01"),
        includeFull: true,
      }),
    );
    expect(slots.map((s) => s.remaining)).toEqual([0, 2]);
  });

  it("returns nothing for a service with non-positive capacity or duration", () => {
    const base = {
      windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(10) }],
      ...dayRange(NY, "2027-06-01"),
    };
    expect(computeSlots(params({ ...base, service: geometry({ capacityPerSlot: 0 }) }))).toEqual([]);
    expect(computeSlots(params({ ...base, service: geometry({ durationMinutes: 0 }) }))).toEqual([]);
  });

  it("uses a weekly window's own limit over the service default", () => {
    // 2027-06-05 is a Saturday (dayOfWeek 6); 2027-06-01 a Tuesday.
    const windows = [
      { dayOfWeek: 2, startMinute: h(9), endMinute: h(10) },
      { dayOfWeek: 6, startMinute: h(9), endMinute: h(10), capacity: 20 },
    ];
    const service = geometry({ capacityPerSlot: 10 });
    const tue = computeSlots(params({ service, windows, ...dayRange(NY, "2027-06-01") }));
    const sat = computeSlots(params({ service, windows, ...dayRange(NY, "2027-06-05") }));
    expect(tue.map((s) => s.capacity)).toEqual([10]);
    expect(sat.map((s) => [s.capacity, s.remaining])).toEqual([[20, 20]]);
  });

  it("lets a date override beat the weekly limit, for the whole day or a time range", () => {
    const windows = [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(12), capacity: 8 }];
    const service = geometry({ capacityPerSlot: 10 });
    const range = dayRange(NY, "2027-06-01");

    const wholeDay = computeSlots(
      params({
        service,
        windows,
        overrides: [{ date: "2027-06-01", startMinute: null, endMinute: null, capacity: 5 }],
        ...range,
      }),
    );
    expect(wholeDay.map((s) => s.capacity)).toEqual([5, 5, 5]);

    const morning = computeSlots(
      params({
        service,
        windows,
        overrides: [
          { date: "2027-06-02", startMinute: null, endMinute: null, capacity: 1 },
          { date: "2027-06-01", startMinute: h(10), endMinute: h(11), capacity: 3 },
        ],
        ...range,
      }),
    );
    expect(morning.map((s) => s.capacity)).toEqual([8, 3, 8]);
  });

  it("hides a slot whose free seats can't fit the smallest allowed booking", () => {
    const nine = at(NY, "2027-06-01T09:00");
    const slots = computeSlots(
      params({
        service: geometry({ capacityPerSlot: 10, minUnitsPerHold: 2 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(11) }],
        usage: [{ startsAt: nine, count: 9 }],
        ...dayRange(NY, "2027-06-01"),
      }),
    );
    expect(localTimes(slots, NY)).toEqual(["10:00"]);
  });
});

describe("computeSlots — 10 people per slot", () => {
  const nine = at(NY, "2027-06-01T09:00");
  const tuesday = { dayOfWeek: 2, startMinute: h(9), endMinute: h(10) };
  const service = geometry({ capacityPerSlot: 10 });
  const run = (count: number, windows = [tuesday], date = "2027-06-01", startsAt = nine) =>
    computeSlots(
      params({ service, windows, usage: [{ startsAt, count }], ...dayRange(NY, date) }),
    );

  it("turns away the 11th person once 10 seats are taken", () => {
    expect(run(10)).toEqual([]);
  });

  it("leaves exactly one seat when 9 are taken, too few for a group of 2", () => {
    const [slot] = run(9);
    expect(slot.remaining).toBe(1);
    // createHold only accepts a hold when remaining >= seats.
    expect(slot.remaining >= 2).toBe(false);
  });

  it("still offers a 20-person Saturday slot after 10 bookings", () => {
    const saturday = { dayOfWeek: 6, startMinute: h(9), endMinute: h(10), capacity: 20 };
    const satNine = at(NY, "2027-06-05T09:00");
    const [slot] = run(10, [saturday], "2027-06-05", satNine);
    expect([slot.capacity, slot.remaining]).toEqual([20, 10]);
  });
});

describe("slotCapacity", () => {
  const service = geometry({ capacityPerSlot: 10 });
  const windows = [{ dayOfWeek: 6, startMinute: h(9), endMinute: h(17), capacity: 20 }];

  it("finds the window and override limits for an instant, ignoring lead time", () => {
    expect(slotCapacity({ service, windows }, at(NY, "2027-06-05T09:00"))).toBe(20);
    expect(
      slotCapacity(
        {
          service,
          windows,
          overrides: [{ date: "2027-06-05", startMinute: null, endMinute: null, capacity: 4 }],
        },
        at(NY, "2027-06-05T09:00"),
      ),
    ).toBe(4);
  });

  it("falls back to the service default outside every window", () => {
    expect(slotCapacity({ service, windows }, at(NY, "2027-06-01T09:00"))).toBe(10);
  });
});

describe("computeSlots — daylight saving time", () => {
  it("skips wall times that do not exist on a spring-forward day", () => {
    // 2027-03-14 is the second Sunday of March: 02:00 -> 03:00 in New York,
    // so 02:00 and 02:30 never occur.
    const slots = computeSlots(
      params({
        service: geometry({ durationMinutes: 30 }),
        windows: [{ dayOfWeek: 0, startMinute: h(1), endMinute: h(4) }],
        ...dayRange(NY, "2027-03-14"),
      }),
    );
    expect(localTimes(slots, NY)).toEqual(["01:00", "01:30", "03:00", "03:30"]);
  });

  it("emits a 23-hour local day's slots at the correct UTC instants", () => {
    const slots = computeSlots(
      params({
        service: geometry({ durationMinutes: 60 }),
        windows: [{ dayOfWeek: 0, startMinute: h(1), endMinute: h(5) }],
        ...dayRange(NY, "2027-03-14"),
      }),
    );
    // 01:00 EST is UTC-5; 03:00 and 04:00 EDT are UTC-4.
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2027-03-14T06:00:00.000Z",
      "2027-03-14T07:00:00.000Z",
      "2027-03-14T08:00:00.000Z",
    ]);
  });

  it("resolves the ambiguous fall-back hour to the earlier offset", () => {
    // 2027-11-07: 02:00 EDT -> 01:00 EST, so 01:00 happens twice. We take the
    // first (EDT, UTC-4) => 05:00Z, not 06:00Z.
    const slots = computeSlots(
      params({
        service: geometry({ durationMinutes: 60 }),
        windows: [{ dayOfWeek: 0, startMinute: h(1), endMinute: h(2) }],
        ...dayRange(NY, "2027-11-07"),
      }),
    );
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2027-11-07T05:00:00.000Z",
    ]);
  });
});

describe("computeSlots — timezones", () => {
  it("converts a non-DST, half-hour-offset zone correctly", () => {
    const slots = computeSlots(
      params({
        service: geometry({ timezone: IST, durationMinutes: 60 }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(11) }],
        ...dayRange(IST, "2027-06-01"),
      }),
    );
    // IST is UTC+5:30 year-round.
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2027-06-01T03:30:00.000Z",
      "2027-06-01T04:30:00.000Z",
    ]);
  });

  it("includes a slot from a local day that starts before the UTC range", () => {
    // Querying 2027-06-01 in IST begins 2027-05-31T18:30Z — the padded day
    // walk must still find the 09:00 IST slot.
    const { rangeStart, rangeEnd } = dayRange(IST, "2027-06-01");
    expect(rangeStart.toISOString()).toBe("2027-05-31T18:30:00.000Z");
    const slots = computeSlots(
      params({
        service: geometry({ timezone: IST }),
        windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(10) }],
        rangeStart,
        rangeEnd,
      }),
    );
    expect(localTimes(slots, IST)).toEqual(["09:00"]);
  });
});

describe("bookableDays", () => {
  it("lists only local dates that have at least one slot", () => {
    const start = DateTime.fromISO("2027-06-01", { zone: NY }).startOf("day");
    const days = bookableDays(
      params({
        // Tuesdays (2) and Thursdays (4) only.
        windows: [
          { dayOfWeek: 2, startMinute: h(9), endMinute: h(10) },
          { dayOfWeek: 4, startMinute: h(9), endMinute: h(10) },
        ],
        rangeStart: start.toJSDate(),
        rangeEnd: start.plus({ days: 7 }).toJSDate(),
      }),
    );
    // 2027-06-01 Tue, 06-03 Thu, 06-08 would be the next Tue (out of range).
    expect(days).toEqual(["2027-06-01", "2027-06-03"]);
  });
});

describe("slotsByDay", () => {
  it("groups every slot under its local date, in order, matching bookableDays", () => {
    const start = DateTime.fromISO("2027-06-01", { zone: NY }).startOf("day");
    const p = params({
      windows: [
        { dayOfWeek: 2, startMinute: h(9), endMinute: h(11) },
        { dayOfWeek: 4, startMinute: h(14), endMinute: h(15) },
      ],
      rangeStart: start.toJSDate(),
      rangeEnd: start.plus({ days: 7 }).toJSDate(),
    });
    const byDay = slotsByDay(p);

    expect(Object.keys(byDay).sort()).toEqual(bookableDays(p));
    expect(byDay["2027-06-01"].map((s) => s.startsAt)).toEqual([
      at(NY, "2027-06-01T09:00"),
      at(NY, "2027-06-01T10:00"),
    ]);
    expect(byDay["2027-06-03"].map((s) => s.startsAt)).toEqual([
      at(NY, "2027-06-03T14:00"),
    ]);
    // Nothing lost or duplicated.
    expect(Object.values(byDay).flat()).toHaveLength(computeSlots(p).length);
  });
});

describe("isOfferedSlot", () => {
  const base = {
    service: geometry(),
    windows: [{ dayOfWeek: 2, startMinute: h(9), endMinute: h(12) }],
    blackouts: [],
    usage: [],
    now: new Date("2027-01-01T00:00:00Z"),
  };

  it("accepts an instant the service genuinely offers", () => {
    expect(isOfferedSlot(base, at(NY, "2027-06-01T09:00"))).toBe(true);
  });

  it("rejects an off-grid instant", () => {
    expect(isOfferedSlot(base, at(NY, "2027-06-01T09:17"))).toBe(false);
  });

  it("rejects an instant outside the opening window", () => {
    expect(isOfferedSlot(base, at(NY, "2027-06-01T20:00"))).toBe(false);
  });

  it("rejects an instant a blackout covers", () => {
    const blacked = {
      ...base,
      blackouts: [
        { startsAt: at(NY, "2027-06-01T09:30"), endsAt: at(NY, "2027-06-01T09:45") },
      ],
    };
    expect(isOfferedSlot(blacked, at(NY, "2027-06-01T09:00"))).toBe(false);
  });

  it("rejects a slot that is already at capacity", () => {
    const full = {
      ...base,
      usage: [{ startsAt: at(NY, "2027-06-01T09:00"), count: 1 }],
    };
    expect(isOfferedSlot(full, at(NY, "2027-06-01T09:00"))).toBe(false);
  });
});
