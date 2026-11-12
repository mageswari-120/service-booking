import { describe, expect, it } from "vitest";

import { bookingLines, orderCustomer } from "./order";

describe("bookingLines", () => {
  it("keeps only line items with booking properties", () => {
    const lines = bookingLines({
      line_items: [
        { id: 1, variant_id: 10, properties: [{ name: "Gift wrap", value: "yes" }] },
        {
          id: 2,
          variant_id: 20,
          properties: [
            { name: "Appointment", value: "Thu, Nov 12" },
            { name: "_booking_start", value: "2026-11-13T14:00:00.000Z" },
            { name: "_booking_hold", value: "abc.def" },
            { name: "_booking_seats", value: "3" },
          ],
        },
      ],
    });
    expect(lines).toEqual([
      {
        lineItemId: "2",
        variantId: "20",
        holdToken: "abc.def",
        start: new Date("2026-11-13T14:00:00.000Z"),
        seats: 3,
      },
    ]);
  });

  it("defaults bad seats to 1 and bad starts to null", () => {
    const [line] = bookingLines({
      line_items: [
        {
          id: 5,
          properties: [
            { name: "_booking_hold", value: "x.y" },
            { name: "_booking_start", value: "nope" },
            { name: "_booking_seats", value: "-2" },
          ],
        },
      ],
    });
    expect(line.seats).toBe(1);
    expect(line.start).toBeNull();
    expect(line.variantId).toBeNull();
  });

  it("handles missing line items and properties", () => {
    expect(bookingLines({})).toEqual([]);
    expect(bookingLines({ line_items: [{ id: 1, properties: null }] })).toEqual([]);
  });
});

describe("orderCustomer", () => {
  it("prefers the customer name and order email", () => {
    expect(
      orderCustomer({
        email: "a@example.com",
        customer: { first_name: "Mageswari", last_name: "", email: "b@example.com" },
        billing_address: { first_name: "Bill", last_name: "Ing" },
      }),
    ).toEqual({ name: "Mageswari", email: "a@example.com", phone: null });
  });

  it("falls back to the billing name and customer email", () => {
    expect(
      orderCustomer({
        customer: { email: "b@example.com" },
        billing_address: { first_name: null, last_name: "Ing", phone: "+1" },
      }),
    ).toEqual({ name: "Ing", email: "b@example.com", phone: "+1" });
  });
});
