import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  chainMinutes,
  chainStarts,
  comboSlots,
  computeSlots,
  evaluateAt,
  leastBusy,
  staffFreeAt,
  staffOffDuty,
} from "./engine";
import type { ComputeSlotsParams, ServiceGeometry } from "./types";

const NY = "America/New_York";
// 2027-06-01 is a Tuesday (dayOfWeek 2).
const TUE = 2;
const h = (hour: number, minute = 0) => hour * 60 + minute;

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

const at = (iso: string) => DateTime.fromISO(iso, { zone: NY }).toJSDate();

function params(over: Partial<ComputeSlotsParams> = {}): ComputeSlotsParams {
  return {
    service: geometry(),
    windows: [{ dayOfWeek: TUE, startMinute: h(9), endMinute: h(12) }],
    blackouts: [],
    usage: [],
    rangeStart: at("2027-06-01T00:00"),
    rangeEnd: at("2027-06-02T00:00"),
    now: new Date("2027-01-01T00:00:00Z"),
    ...over,
  };
}

const times = (slots: { startsAt: Date }[]) =>
  slots.map((s) => DateTime.fromJSDate(s.startsAt, { zone: NY }).toFormat("HH:mm"));

describe("staffFreeAt", () => {
  const span = { startsAt: at("2027-06-01T10:00"), endsAt: at("2027-06-01T11:00") };

  it("is null when the service has no staff", () => {
    expect(staffFreeAt(undefined, span)).toBeNull();
    expect(staffFreeAt({ ids: [], busy: {} }, span)).toBeNull();
  });

  it("drops staff with an overlapping appointment, keeping the order", () => {
    const busy = {
      b: [{ startsAt: at("2027-06-01T10:30"), endsAt: at("2027-06-01T11:30") }],
      // Touching at the edge is not an overlap (half-open intervals).
      c: [{ startsAt: at("2027-06-01T11:00"), endsAt: at("2027-06-01T12:00") }],
    };
    expect(staffFreeAt({ ids: ["a", "b", "c"], busy }, span)).toEqual(["a", "c"]);
  });
});

describe("computeSlots with staff", () => {
  it("lists free staff per slot and fills a slot with no one free", () => {
    const staff = {
      ids: ["p1", "p2"],
      busy: {
        // p1 busy 9:30–10:30 (any service): blocks the 9:00 and 10:00 slots.
        p1: [{ startsAt: at("2027-06-01T09:30"), endsAt: at("2027-06-01T10:30") }],
        p2: [{ startsAt: at("2027-06-01T10:00"), endsAt: at("2027-06-01T11:00") }],
      },
    };
    const service = geometry({ capacityPerSlot: 5 });
    const slots = computeSlots(params({ staff, service, includeFull: true }));
    expect(times(slots)).toEqual(["09:00", "10:00", "11:00"]);
    expect(slots.map((s) => s.staff)).toEqual([["p2"], [], ["p1", "p2"]]);
    // Free staff don't cap seats; no one free makes the slot full.
    expect(slots.map((s) => s.remaining)).toEqual([5, 0, 5]);
    expect(times(computeSlots(params({ staff, service })))).toEqual(["09:00", "11:00"]);
  });

  it("counts the slot's buffers against staff time", () => {
    const staff = {
      ids: ["p1"],
      busy: { p1: [{ startsAt: at("2027-06-01T11:00"), endsAt: at("2027-06-01T12:00") }] },
    };
    const slots = computeSlots(params({ staff, service: geometry({ bufferAfterMinutes: 15 }) }));
    // 10:00 + 60 min + 15 min buffer runs into p1's 11:00.
    expect(times(slots)).toEqual(["09:00"]);
  });

  it("leaves slots unchanged without staff", () => {
    expect(computeSlots(params()).every((s) => s.staff === undefined)).toBe(true);
  });
});

describe("chainStarts / chainMinutes", () => {
  it("runs services back to back, with buffers between them", () => {
    const a = geometry({ durationMinutes: 60, bufferAfterMinutes: 10 });
    const b = geometry({ durationMinutes: 30, bufferBeforeMinutes: 5 });
    const c = geometry({ durationMinutes: 45 });
    const starts = chainStarts([a, b, c], at("2027-06-01T09:00"));
    expect(times(starts.map((startsAt) => ({ startsAt })))).toEqual(["09:00", "10:15", "10:45"]);
    expect(chainMinutes([a, b, c])).toBe(150);
    expect(chainMinutes([a])).toBe(60);
  });
});

describe("evaluateAt", () => {
  it("accepts a start off the slot grid inside a window", () => {
    expect(evaluateAt(params(), at("2027-06-01T09:20"))).toMatchObject({
      capacity: 1,
      remaining: 1,
    });
  });

  it("rejects starts that don't fit, are closed or blacked out", () => {
    expect(evaluateAt(params(), at("2027-06-01T11:30"))).toBeNull();
    expect(evaluateAt(params(), at("2027-06-01T08:00"))).toBeNull();
    const closed = params({
      overrides: [{ date: "2027-06-01", startMinute: null, endMinute: null, capacity: 0 }],
    });
    expect(evaluateAt(closed, at("2027-06-01T10:00"))).toBeNull();
    const blackout = params({
      blackouts: [{ startsAt: at("2027-06-01T10:30"), endsAt: at("2027-06-01T10:45") }],
    });
    expect(evaluateAt(blackout, at("2027-06-01T10:00"))).toBeNull();
  });

  it("reports full when its exact start is used up", () => {
    const used = params({ usage: [{ startsAt: at("2027-06-01T10:00"), count: 1 }] });
    expect(evaluateAt(used, at("2027-06-01T10:00"))?.remaining).toBe(0);
  });
});

describe("comboSlots", () => {
  const first = () => params({ service: geometry({ capacityPerSlot: 3 }) });

  it("is computeSlots for a single service", () => {
    expect(comboSlots([first()])).toEqual(computeSlots(first()));
  });

  it("offers a start only when the next service fits right after", () => {
    // Second service: 30 minutes, open 10:00–12:00 only.
    const second = params({
      service: geometry({ durationMinutes: 30, capacityPerSlot: 2 }),
      windows: [{ dayOfWeek: TUE, startMinute: h(10), endMinute: h(12) }],
    });
    const slots = comboSlots([first(), second]);
    // 9:00 → second at 10:00 ✓; 10:00 → 11:00 ✓; 11:00 → 12:00 doesn't fit.
    expect(times(slots)).toEqual(["09:00", "10:00"]);
    expect(slots[0]).toMatchObject({ capacity: 2, remaining: 2 });
    expect(DateTime.fromJSDate(slots[0].endsAt, { zone: NY }).toFormat("HH:mm")).toBe("10:30");
  });

  it("drops starts where a later service is closed by an override", () => {
    const second = params({
      service: geometry({ durationMinutes: 30 }),
      overrides: [{ date: "2027-06-01", startMinute: h(10), endMinute: h(11), capacity: 0 }],
    });
    // 9:00 → second at 10:00 (closed); 10:00 → 11:00 ✓; 11:00 → 12:00 doesn't fit.
    expect(times(comboSlots([first(), second]))).toEqual(["10:00"]);
  });

  it("needs one person free for every staffed service", () => {
    const busy = {
      p1: [{ startsAt: at("2027-06-01T10:00"), endsAt: at("2027-06-01T10:30") }],
      p2: [{ startsAt: at("2027-06-01T12:00"), endsAt: at("2027-06-01T13:00") }],
    };
    const a = params({ staff: { ids: ["p1", "p2"], busy }, includeFull: true });
    const b = params({
      service: geometry({ durationMinutes: 30 }),
      windows: [{ dayOfWeek: TUE, startMinute: h(9), endMinute: h(14) }],
      // Only p1 performs the second service.
      staff: { ids: ["p1"], busy },
    });
    const slots = comboSlots([a, b]);
    expect(times(slots)).toEqual(["09:00", "10:00", "11:00"]);
    // 9:00: B at 10:00, p1 busy then and p2 doesn't do B → nobody.
    // 10:00: p1 busy during A → nobody (p2 doesn't do B).
    // 11:00: p1 free for A (11–12) and B (12–12:30).
    expect(slots.map((s) => s.staff)).toEqual([[], [], ["p1"]]);
    expect(slots.map((s) => s.remaining)).toEqual([0, 0, 1]);
    expect(times(comboSlots([{ ...a, includeFull: false }, b]))).toEqual(["11:00"]);
  });
});

describe("staff hours and days off", () => {
  // Works Tuesdays 10:00–11:00 only.
  const schedule = { hours: [{ dayOfWeek: TUE, startMinute: h(10), endMinute: h(11) }], daysOff: [] };
  const offFor = (s: typeof schedule | { hours: null; daysOff: string[] }) =>
    staffOffDuty(s, NY, at("2027-05-31T00:00"), at("2027-06-03T00:00"));

  it("is off outside their hours and on days without hours", () => {
    const off = offFor(schedule);
    const staff = { ids: ["p1"], busy: {}, off: { p1: off } };
    const slots = computeSlots(params({ staff, includeFull: true }));
    expect(slots.map((s) => [DateTime.fromJSDate(s.startsAt, { zone: NY }).toFormat("HH:mm"), s.remaining])).toEqual([
      ["09:00", 0],
      ["10:00", 1],
      ["11:00", 0],
    ]);
    // Monday is a day without hours: off from midnight to midnight.
    expect(off.some((i) => i.startsAt.getTime() === at("2027-05-31T00:00").getTime())).toBe(true);
  });

  it("is off all day on a day off", () => {
    const off = offFor({ hours: null, daysOff: ["2027-06-01"] });
    const slots = computeSlots(params({ staff: { ids: ["p1"], busy: {}, off: { p1: off } }, includeFull: true }));
    expect(slots.every((s) => s.remaining === 0)).toBe(true);
  });

  it("changes nothing without own hours or days off", () => {
    expect(offFor({ hours: null, daysOff: [] })).toEqual([]);
    const slots = computeSlots(params({ staff: { ids: ["p1"], busy: {}, off: { p1: [] } } }));
    expect(slots).toHaveLength(3);
  });

  it("checks hours against the appointment, not its buffers", () => {
    const off = offFor(schedule);
    const span = { startsAt: at("2027-06-01T09:45"), endsAt: at("2027-06-01T11:15") };
    const appointment = { startsAt: at("2027-06-01T10:00"), endsAt: at("2027-06-01T11:00") };
    expect(staffFreeAt({ ids: ["p1"], busy: {}, off: { p1: off } }, span, appointment)).toEqual(["p1"]);
  });

  it("follows the local day across a DST change", () => {
    // 2027-03-14: New York springs forward. Sunday 10:00–11:00 local.
    const off = staffOffDuty(
      { hours: [{ dayOfWeek: 0, startMinute: h(10), endMinute: h(11) }], daysOff: [] },
      NY,
      at("2027-03-14T00:00"),
      at("2027-03-14T12:00"),
    );
    const free = staffFreeAt(
      { ids: ["p1"], busy: {}, off: { p1: off } },
      { startsAt: at("2027-03-14T10:00"), endsAt: at("2027-03-14T11:00") },
    );
    expect(free).toEqual(["p1"]);
  });
});

describe("leastBusy", () => {
  const busy = {
    p1: [{ startsAt: at("2027-06-01T09:00"), endsAt: at("2027-06-01T10:00") }],
    p2: [{ startsAt: at("2027-06-02T09:00"), endsAt: at("2027-06-02T10:00") }],
  };
  const staff = { ids: ["p1", "p2"], busy };

  it("picks whoever has the fewest bookings that day", () => {
    expect(leastBusy(["p1", "p2"], staff, at("2027-06-01T14:00"), NY)).toBe("p2");
    expect(leastBusy(["p1", "p2"], staff, at("2027-06-02T14:00"), NY)).toBe("p1");
  });

  it("keeps the merchant's order on a tie", () => {
    expect(leastBusy(["p1", "p2"], staff, at("2027-06-05T14:00"), NY)).toBe("p1");
    expect(leastBusy(["p2"], staff, at("2027-06-02T14:00"), NY)).toBe("p2");
  });
});
