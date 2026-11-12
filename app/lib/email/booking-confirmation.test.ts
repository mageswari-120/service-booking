import { describe, expect, it } from "vitest";

import { renderBookingConfirmation } from "./booking-confirmation";

const base = {
  shopName: "Yogababble",
  serviceTitle: "Personal Consultation",
  // 14:00 UTC = 7:30 pm in Asia/Kolkata (UTC+5:30)
  startsAt: new Date("2026-11-13T14:00:00Z"),
  endsAt: new Date("2026-11-13T14:30:00Z"),
  timezone: "Asia/Kolkata",
  seats: 1,
  orderName: "#1001",
  bookingId: "bk_1",
  customerName: "Mageswari",
  answers: [],
  signed: false,
};

describe("renderBookingConfirmation", () => {
  it("formats date and time in the service timezone", () => {
    const { subject, html, text } = renderBookingConfirmation(base);
    expect(subject).toBe("Personal Consultation: Your Upcoming Booking");
    expect(text).toContain("What: Personal Consultation - 30 minutes");
    expect(text).toContain("When: November 13, 2026, 7:30 pm - 8:00 pm (Asia/Kolkata)");
    expect(text).toContain("Booking ID: #1001");
    expect(html).toContain("Hi Mageswari,");
    expect(html).not.toContain("Additional Information");
  });

  it("lists answers and the signature", () => {
    const { html, text } = renderBookingConfirmation({
      ...base,
      orderName: null,
      answers: [
        { id: "g", label: "What are your goals?", value: "Flexibility" },
        { id: "t", label: "Do you accept the terms?", value: true },
      ],
      signed: true,
    });
    expect(html).toContain("Additional Information");
    expect(text).toContain("What are your goals?: Flexibility");
    expect(text).toContain("Do you accept the terms?: Yes");
    expect(text).toContain("Signature: Signed");
    expect(text).toContain("Booking ID: bk_1");
  });

  it("escapes customer-supplied text", () => {
    const { html } = renderBookingConfirmation({
      ...base,
      customerName: "<script>x</script>",
      answers: [{ id: "g", label: "Goals", value: '<img src=x onerror="y">' }],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });
});
