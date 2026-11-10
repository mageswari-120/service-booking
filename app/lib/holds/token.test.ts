import { describe, expect, it } from "vitest";

import { signHoldToken, verifyHoldToken } from "./token";

const SECRET = "a".repeat(64);

describe("hold tokens", () => {
  it("round-trips the hold ID", () => {
    const token = signHoldToken("clxhold123", SECRET);
    expect(verifyHoldToken(token, SECRET)).toBe("clxhold123");
  });

  it("rejects a token whose hold ID was swapped", () => {
    const [, sig] = signHoldToken("clxhold123", SECRET).split(".");
    expect(verifyHoldToken(`clxhold999.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signHoldToken("clxhold123", SECRET);
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyHoldToken(flipped, SECRET)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const token = signHoldToken("clxhold123", "b".repeat(64));
    expect(verifyHoldToken(token, SECRET)).toBeNull();
  });

  it("rejects malformed input", () => {
    for (const bad of [undefined, null, "", "nodot", ".sigonly", "id."]) {
      expect(verifyHoldToken(bad, SECRET)).toBeNull();
    }
  });
});
