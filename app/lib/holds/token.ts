import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Hold tokens travel through the customer's cart as a line item property, so
 * the customer can edit them. Signing stops a forged or guessed `_booking_hold`
 * from claiming somebody else's hold when the order comes in.
 *
 * Format: `<holdId>.<base64url HMAC-SHA256(holdId)>`.
 */

export function signHoldToken(holdId: string, secret: string): string {
  return `${holdId}.${mac(holdId, secret)}`;
}

/** The hold ID if the token is genuine, else null. */
export function verifyHoldToken(
  token: string | null | undefined,
  secret: string,
): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const holdId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(holdId, secret));
  if (given.length !== expected.length) return null;
  return timingSafeEqual(given, expected) ? holdId : null;
}

export function holdSecret(): string {
  const secret = process.env.BOOKING_HOLD_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "BOOKING_HOLD_SECRET is missing or too short. Generate one with: openssl rand -hex 32",
    );
  }
  return secret;
}

function mac(holdId: string, secret: string): string {
  return createHmac("sha256", secret).update(holdId).digest("base64url");
}
