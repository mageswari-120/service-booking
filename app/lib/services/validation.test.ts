import { describe, expect, it } from "vitest";

import {
  minutesToHhMm,
  parseServiceInput,
  type ServiceFormInput,
} from "./validation";

function valid(overrides: Partial<ServiceFormInput> = {}): ServiceFormInput {
  return {
    shopifyProductId: "gid://shopify/Product/1",
    shopifyVariantId: "gid://shopify/ProductVariant/2",
    title: "  Haircut  ",
    active: true,
    durationMinutes: "60",
    bufferBeforeMinutes: "0",
    bufferAfterMinutes: "15",
    slotIntervalMinutes: "",
    leadTimeMinutes: "120",
    maxAdvanceDays: "60",
    capacityPerSlot: "1",
    capacityMode: "PEOPLE",
    minSeatsPerBooking: "1",
    maxSeatsPerBooking: "",
    timezone: "",
    windows: [{ dayOfWeek: 1, start: "09:00", end: "17:00" }],
    capacityOverrides: [],
    intakeQuestions: [],
    requireSignature: false,
    upsellVariantIds: [],
    ...overrides,
  };
}

function errorsOf(input: ServiceFormInput) {
  const result = parseServiceInput(input);
  if (result.ok) throw new Error("expected validation to fail");
  return result.errors;
}

describe("parseServiceInput", () => {
  it("accepts a valid form and normalises it", () => {
    const result = parseServiceInput(valid());
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        title: "Haircut",
        durationMinutes: 60,
        bufferAfterMinutes: 15,
        slotIntervalMinutes: null,
        timezone: null,
        windows: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020, capacity: null }],
        capacityMode: "PEOPLE",
        minSeatsPerBooking: 1,
        maxSeatsPerBooking: null,
        capacityOverrides: [],
      }),
    });
  });

  it("allows a service with no opening hours yet", () => {
    expect(parseServiceInput(valid({ windows: [] })).ok).toBe(true);
  });

  it("requires a product variant", () => {
    expect(errorsOf(valid({ shopifyVariantId: "" }))).toHaveProperty(
      "shopifyVariantId",
    );
    expect(errorsOf(valid({ shopifyProductId: "" }))).toHaveProperty(
      "shopifyVariantId",
    );
  });

  it("rejects non-integer and out-of-range numbers", () => {
    const errors = errorsOf(
      valid({ durationMinutes: "1.5", capacityPerSlot: "0", maxAdvanceDays: "" }),
    );
    expect(Object.keys(errors).sort()).toEqual([
      "capacityPerSlot",
      "durationMinutes",
      "maxAdvanceDays",
    ]);
  });

  describe("slot limits", () => {
    it("parses per-window limits and date overrides", () => {
      const result = parseServiceInput(
        valid({
          capacityPerSlot: "10",
          windows: [
            { dayOfWeek: 1, start: "09:00", end: "17:00" },
            { dayOfWeek: 6, start: "09:00", end: "17:00", capacity: "20" },
          ],
          capacityOverrides: [
            { date: "2027-12-24", start: "", end: "", capacity: "5" },
            { date: "2027-12-31", start: "10:00", end: "12:00", capacity: "3" },
          ],
        }),
      );
      expect(result.ok && result.data.windows.map((w) => w.capacity)).toEqual([null, 20]);
      expect(result.ok && result.data.capacityOverrides).toEqual([
        { date: "2027-12-24", startMinute: null, endMinute: null, capacity: 5 },
        { date: "2027-12-31", startMinute: 600, endMinute: 720, capacity: 3 },
      ]);
    });

    it("rejects bad override dates, half-filled times and empty limits", () => {
      const errors = errorsOf(
        valid({
          capacityOverrides: [
            { date: "2027-02-30", start: "", end: "", capacity: "5" },
            { date: "2027-03-01", start: "10:00", end: "", capacity: "5" },
            { date: "2027-03-02", start: "12:00", end: "10:00", capacity: "5" },
            { date: "2027-03-03", start: "", end: "", capacity: "" },
          ],
        }),
      );
      expect(Object.keys(errors).sort()).toEqual([
        "capacityOverrides.0",
        "capacityOverrides.1",
        "capacityOverrides.2",
        "capacityOverrides.3",
      ]);
    });

    it("rejects a bad window limit", () => {
      expect(
        errorsOf(valid({ windows: [{ dayOfWeek: 1, start: "09:00", end: "17:00", capacity: "0" }] })),
      ).toHaveProperty("windows.0");
    });

    it("checks min and max people per booking", () => {
      expect(
        errorsOf(valid({ capacityPerSlot: "10", minSeatsPerBooking: "4", maxSeatsPerBooking: "2" })),
      ).toHaveProperty("maxSeatsPerBooking");
      // In people mode, a minimum party bigger than every slot can never book…
      expect(errorsOf(valid({ capacityPerSlot: "3", minSeatsPerBooking: "4" }))).toHaveProperty(
        "minSeatsPerBooking",
      );
      // …unless some hours allow more.
      expect(
        parseServiceInput(
          valid({
            capacityPerSlot: "3",
            minSeatsPerBooking: "4",
            windows: [{ dayOfWeek: 6, start: "09:00", end: "17:00", capacity: "8" }],
          }),
        ).ok,
      ).toBe(true);
      // In bookings mode the limit counts bookings, so party size is independent.
      const bookings = parseServiceInput(
        valid({ capacityMode: "BOOKINGS", capacityPerSlot: "2", minSeatsPerBooking: "4", maxSeatsPerBooking: "6" }),
      );
      expect(bookings.ok && bookings.data).toMatchObject({
        capacityMode: "BOOKINGS",
        minSeatsPerBooking: 4,
        maxSeatsPerBooking: 6,
      });
    });
  });

  it("keeps an explicit slot interval", () => {
    const result = parseServiceInput(valid({ slotIntervalMinutes: "30" }));
    expect(result.ok && result.data.slotIntervalMinutes).toBe(30);
  });

  it("validates the timezone override", () => {
    expect(errorsOf(valid({ timezone: "Mars/Olympus" }))).toHaveProperty("timezone");
    const result = parseServiceInput(valid({ timezone: "Asia/Kolkata" }));
    expect(result.ok && result.data.timezone).toBe("Asia/Kolkata");
  });

  it("treats a 00:00 closing time as midnight", () => {
    const result = parseServiceInput(
      valid({ windows: [{ dayOfWeek: 5, start: "18:00", end: "00:00" }] }),
    );
    expect(result.ok && result.data.windows[0].endMinute).toBe(1440);
  });

  it("rejects hours that close before they open", () => {
    expect(
      errorsOf(valid({ windows: [{ dayOfWeek: 1, start: "17:00", end: "09:00" }] })),
    ).toEqual({ "windows.0": "Closing time must be after opening time." });
  });

  it("rejects hours too short to fit one appointment", () => {
    expect(
      errorsOf(valid({ windows: [{ dayOfWeek: 1, start: "09:00", end: "09:30" }] })),
    ).toHaveProperty("windows.0");
  });

  it("puts the overlap error on the later row, past an earlier bad row", () => {
    const errors = errorsOf(
      valid({
        windows: [
          { dayOfWeek: 2, start: "bad", end: "10:00" },
          { dayOfWeek: 1, start: "09:00", end: "13:00" },
          { dayOfWeek: 1, start: "12:00", end: "17:00" },
        ],
      }),
    );
    expect(errors["windows.0"]).toBe("Use a valid time.");
    expect(errors["windows.2"]).toBe("Overlaps other Monday hours.");
    expect(errors).not.toHaveProperty("windows.1");
  });

  it("allows back-to-back windows on the same day", () => {
    const result = parseServiceInput(
      valid({
        windows: [
          { dayOfWeek: 1, start: "13:00", end: "17:00" },
          { dayOfWeek: 1, start: "09:00", end: "13:00" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("parseServiceInput — booking popup details", () => {
  it("normalises questions, signature and add-ons", () => {
    const result = parseServiceInput(
      valid({
        intakeQuestions: [
          { id: "q_1", type: "text", label: "  Goals ", help: "  ", required: false },
          { id: "q_2", type: "checkbox", label: "Accept terms", help: "See policy", required: true },
        ],
        requireSignature: true,
        upsellVariantIds: [
          "gid://shopify/ProductVariant/7",
          "gid://shopify/ProductVariant/7",
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        intakeQuestions: [
          { id: "q_1", type: "text", label: "Goals", required: false },
          { id: "q_2", type: "checkbox", label: "Accept terms", help: "See policy", required: true },
        ],
        requireSignature: true,
        upsellVariantIds: ["gid://shopify/ProductVariant/7"],
      }),
    });
  });

  it("flags bad question rows by index", () => {
    const errors = errorsOf(
      valid({
        intakeQuestions: [
          { id: "q_1", type: "text", label: "Ok", required: false },
          { id: "q_2", type: "text", label: "   ", required: false },
          { id: "q_1", type: "text", label: "Duplicate id", required: false },
          { id: "q_4", type: "radio" as "text", label: "Bad type", required: false },
        ],
      }),
    );
    expect(Object.keys(errors).sort()).toEqual([
      "intakeQuestions.1",
      "intakeQuestions.2",
      "intakeQuestions.3",
    ]);
  });

  it("validates add-on products", () => {
    expect(errorsOf(valid({ upsellVariantIds: ["gid://shopify/Product/1"] }))).toHaveProperty(
      "upsellVariantIds",
    );
    expect(
      errorsOf(valid({ upsellVariantIds: ["gid://shopify/ProductVariant/2"] })),
    ).toHaveProperty("upsellVariantIds");
    expect(
      errorsOf(
        valid({
          upsellVariantIds: [1, 2, 3, 4, 5, 6].map((n) => `gid://shopify/ProductVariant/${n + 10}`),
        }),
      ),
    ).toHaveProperty("upsellVariantIds");
  });
});

describe("minutesToHhMm", () => {
  it("formats minutes and wraps midnight", () => {
    expect(minutesToHhMm(545)).toBe("09:05");
    expect(minutesToHhMm(1440)).toBe("00:00");
  });
});
