import { describe, expect, it } from "vitest";

import {
  MAX_SIGNATURE_BYTES,
  parseQuestions,
  validateHoldDetails,
  type IntakeQuestion,
} from "./details";

const questions: IntakeQuestion[] = [
  { id: "goals", type: "text", label: "Your goals", required: false },
  { id: "name2", type: "text", label: "Guest name", required: true },
  { id: "terms", type: "checkbox", label: "Accept terms", required: true },
];
const service = { questions, requireSignature: false, capacityPerSlot: 5 };

/** Smallest valid-looking PNG: magic bytes + padding. */
function png(size = 64): string {
  const bytes = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(bytes);
  return "data:image/png;base64," + bytes.toString("base64");
}

const ok = { seats: 2, answers: { name2: "Sam", terms: true } };

describe("parseQuestions", () => {
  it("keeps well-formed questions and drops the rest", () => {
    expect(
      parseQuestions([
        { id: "a", type: "text", label: " Hi ", required: true },
        { id: "b", type: "radio", label: "x" },
        { id: "", type: "text", label: "x" },
        { id: "c", type: "checkbox", label: "  " },
        "nope",
      ]),
    ).toEqual([{ id: "a", type: "text", label: "Hi", help: undefined, required: true }]);
    expect(parseQuestions(null)).toEqual([]);
  });
});

describe("validateHoldDetails", () => {
  it("accepts a complete submission and snapshots labels", () => {
    const r = validateHoldDetails(service, ok);
    expect(r).toEqual({
      ok: true,
      seats: 2,
      signaturePng: null,
      answers: [
        { id: "name2", label: "Guest name", value: "Sam" },
        { id: "terms", label: "Accept terms", value: true },
      ],
    });
  });

  it("defaults seats to 1 and bounds it by capacity", () => {
    const one = validateHoldDetails(service, { answers: ok.answers });
    expect(one.ok && one.seats).toBe(1);
    for (const seats of [0, 6, 1.5, "x"]) {
      expect(validateHoldDetails(service, { ...ok, seats })).toMatchObject({
        ok: false,
        field: "seats",
      });
    }
  });

  it("requires required text and checkbox answers", () => {
    expect(
      validateHoldDetails(service, { seats: 1, answers: { terms: true, name2: "  " } }),
    ).toMatchObject({ ok: false, field: "name2" });
    expect(
      validateHoldDetails(service, { seats: 1, answers: { name2: "Sam", terms: "true" } }),
    ).toMatchObject({ ok: false, field: "terms" });
  });

  it("drops unknown question ids and rejects over-long text", () => {
    const r = validateHoldDetails(service, { ...ok, answers: { ...ok.answers, evil: "x" } });
    expect(r.ok && r.answers.map((a) => a.id)).toEqual(["name2", "terms"]);
    expect(
      validateHoldDetails(service, { ...ok, answers: { ...ok.answers, goals: "x".repeat(501) } }),
    ).toMatchObject({ ok: false, field: "goals" });
  });

  it("checks the signature format, size and requirement", () => {
    const signed = { ...service, requireSignature: true };
    expect(validateHoldDetails(signed, ok)).toMatchObject({ ok: false, field: "signature" });

    const r = validateHoldDetails(signed, { ...ok, signature: png() });
    expect(r.ok && r.signaturePng?.length).toBe(64);

    for (const signature of [
      "data:image/jpeg;base64,AAAA",
      "data:image/png;base64," + Buffer.from("not a png").toString("base64"),
      png(MAX_SIGNATURE_BYTES + 1),
    ]) {
      expect(validateHoldDetails(signed, { ...ok, signature })).toMatchObject({
        ok: false,
        field: "signature",
      });
    }
  });
});
