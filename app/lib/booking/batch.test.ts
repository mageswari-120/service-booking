import { describe, expect, it } from "vitest";

import { splitByService } from "./batch";

const at = (iso: string) => new Date(iso);
const row = (serviceId: string, start: string, seats: number, count: number) => ({
  serviceId,
  startsAt: at(start),
  _sum: { seats },
  _count: { _all: count },
});

describe("splitByService", () => {
  const services = [
    { id: "a", capacityMode: "PEOPLE" as const },
    { id: "b", capacityMode: "BOOKINGS" as const },
  ];

  it("gives each service only its own holds and bookings", () => {
    const out = splitByService(
      services,
      [],
      [row("a", "2026-12-01T10:00:00Z", 3, 1), row("b", "2026-12-01T10:00:00Z", 4, 2)],
      [row("a", "2026-12-02T10:00:00Z", 2, 1), row("x", "2026-12-02T10:00:00Z", 9, 9)],
    );
    expect(out.get("a")!.usage).toEqual([
      { startsAt: at("2026-12-01T10:00:00Z"), count: 3 },
      { startsAt: at("2026-12-02T10:00:00Z"), count: 2 },
    ]);
    // BOOKINGS mode counts rows, not seats.
    expect(out.get("b")!.usage).toEqual([{ startsAt: at("2026-12-01T10:00:00Z"), count: 2 }]);
  });

  it("sends shop-wide blackouts to every service and own blackouts to one", () => {
    const shopWide = { serviceId: null, startsAt: at("2026-12-25T00:00:00Z"), endsAt: at("2026-12-26T00:00:00Z") };
    const onlyB = { serviceId: "b", startsAt: at("2026-12-03T00:00:00Z"), endsAt: at("2026-12-04T00:00:00Z") };
    const out = splitByService(services, [shopWide, onlyB], [], []);
    expect(out.get("a")!.blackouts).toHaveLength(1);
    expect(out.get("b")!.blackouts).toHaveLength(2);
    expect(out.get("a")!.blackouts[0]).toEqual({ startsAt: shopWide.startsAt, endsAt: shopWide.endsAt });
  });

  it("treats a null seat sum as zero", () => {
    const out = splitByService(services, [], [{ ...row("a", "2026-12-01T10:00:00Z", 0, 1), _sum: { seats: null } }], []);
    expect(out.get("a")!.usage[0].count).toBe(0);
  });
});
