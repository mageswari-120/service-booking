/**
 * The booking popup's second step: intake questions, people count and
 * signature. Pure (no DB, no Shopify) so both the hold endpoint and the admin
 * form validation share it, and it is unit-tested in details.test.ts.
 */

export type QuestionType = "text" | "checkbox";

export interface IntakeQuestion {
  id: string;
  type: QuestionType;
  label: string;
  help?: string;
  required: boolean;
}

/** What a hold stores and the orders handler copies onto the Booking. */
export interface IntakeAnswer {
  id: string;
  label: string; // snapshot: the merchant may rename the question later
  value: string | boolean;
}

export const MAX_QUESTIONS = 10;
/** Highest slot limit or party size the admin accepts. */
export const MAX_SEATS = 1000;
export const MAX_LABEL = 200;
export const MAX_HELP = 300;
export const MAX_ANSWER = 500;
/** Decoded PNG size cap; a drawn signature is typically 5–40 KB. */
export const MAX_SIGNATURE_BYTES = 200 * 1024;

const PNG_PREFIX = "data:image/png;base64,";
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/**
 * Questions as stored on Service.intakeQuestions (JSON). Lenient: anything
 * malformed is dropped rather than breaking the storefront.
 */
export function parseQuestions(raw: unknown): IntakeQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: IntakeQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const { id, type, label, help, required } = q as Record<string, unknown>;
    if (typeof id !== "string" || !id) continue;
    if (type !== "text" && type !== "checkbox") continue;
    if (typeof label !== "string" || !label.trim()) continue;
    out.push({
      id,
      type,
      label: label.trim(),
      help: typeof help === "string" && help.trim() ? help.trim() : undefined,
      required: required === true,
    });
  }
  return out.slice(0, MAX_QUESTIONS);
}

/** Answers as stored on SlotHold/Booking.intakeAnswers (JSON). Lenient. */
export function parseAnswers(raw: unknown): IntakeAnswer[] {
  if (!Array.isArray(raw)) return [];
  const out: IntakeAnswer[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const { id, label, value } = a as Record<string, unknown>;
    if (typeof id !== "string" || typeof label !== "string") continue;
    if (typeof value !== "string" && typeof value !== "boolean") continue;
    out.push({ id, label, value });
  }
  return out;
}

export type HoldDetailsResult =
  | { ok: true; seats: number; answers: IntakeAnswer[]; signaturePng: Buffer | null }
  | { ok: false; error: string; field: string };

/**
 * Check what the customer submitted with a hold. The widget checks the same
 * things first; this is the authoritative copy.
 */
export function validateHoldDetails(
  service: {
    questions: IntakeQuestion[];
    requireSignature: boolean;
    /** Smallest party per booking. */
    minSeats: number;
    /** Largest party per booking; null => only the slot's free seats limit it. */
    maxSeats: number | null;
  },
  body: { seats?: unknown; answers?: unknown; signature?: unknown },
): HoldDetailsResult {
  const min = Math.max(1, service.minSeats);
  // With no per-booking maximum, the hold's capacity check is the real limit.
  const max = service.maxSeats ?? MAX_SEATS;
  const seats = body.seats === undefined ? min : Number(body.seats);
  if (!Number.isInteger(seats) || seats < min || seats > max) {
    return {
      ok: false,
      field: "seats",
      error:
        service.maxSeats === null
          ? `Choose at least ${min} ${min === 1 ? "person" : "people"}.`
          : min === max
            ? `This booking is for exactly ${min} ${min === 1 ? "person" : "people"}.`
            : `Choose between ${min} and ${max} people.`,
    };
  }

  const given =
    body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
      ? (body.answers as Record<string, unknown>)
      : {};
  const answers: IntakeAnswer[] = [];
  // Only known questions are kept; anything else in the body is ignored.
  for (const q of service.questions) {
    const raw = given[q.id];
    if (q.type === "checkbox") {
      const checked = raw === true;
      if (q.required && !checked) {
        return { ok: false, field: q.id, error: `Please tick "${q.label}".` };
      }
      answers.push({ id: q.id, label: q.label, value: checked });
    } else {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text.length > MAX_ANSWER) {
        return { ok: false, field: q.id, error: `"${q.label}" is too long.` };
      }
      if (q.required && !text) {
        return { ok: false, field: q.id, error: `Please answer "${q.label}".` };
      }
      if (text) answers.push({ id: q.id, label: q.label, value: text });
    }
  }

  let signaturePng: Buffer | null = null;
  if (typeof body.signature === "string" && body.signature) {
    if (!body.signature.startsWith(PNG_PREFIX)) {
      return { ok: false, field: "signature", error: "Invalid signature image." };
    }
    const bytes = Buffer.from(body.signature.slice(PNG_PREFIX.length), "base64");
    if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) {
      return { ok: false, field: "signature", error: "Invalid signature image." };
    }
    if (bytes.length > MAX_SIGNATURE_BYTES) {
      return { ok: false, field: "signature", error: "Signature image is too large." };
    }
    signaturePng = bytes;
  }
  if (service.requireSignature && !signaturePng) {
    return { ok: false, field: "signature", error: "Please sign before booking." };
  }

  return { ok: true, seats, answers, signaturePng };
}
