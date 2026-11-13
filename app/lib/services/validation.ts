/**
 * Validation for the merchant's service form.
 *
 * Pure: no database, no Shopify. The admin route parses the submitted JSON
 * through `parseServiceInput` and either saves the result or hands the error
 * map straight back to the form, keyed by field so Polaris can show each
 * message under its own input.
 */

import {
  MAX_HELP,
  MAX_LABEL,
  MAX_QUESTIONS,
  MAX_SEATS,
  type IntakeQuestion,
} from "../booking/details";

/** Most add-on products offered in the booking popup. */
export const MAX_UPSELLS = 5;

/** Most products one service can be offered on as an add-on. */
export const MAX_ADDON_PRODUCTS = 50;

/** The add-on card is one line of a product page: keep its wording short. */
export const MAX_ADDON_LABEL = 80;
export const MAX_ADDON_DESCRIPTION = 200;
export const MAX_ADDON_BADGE = 24;

export interface WindowInput {
  dayOfWeek: number;
  /** "HH:MM", 24-hour, service-local. */
  start: string;
  /** "HH:MM". "00:00" as an end time means midnight at the end of the day. */
  end: string;
  /** Slot limit for these hours. Empty/null => the service's default. */
  capacity?: number | string | null;
}

/** Most date-specific limits per service. */
export const MAX_OVERRIDES = 100;

export interface OverrideInput {
  /** "YYYY-MM-DD", service-local. */
  date: string;
  /** "HH:MM"; both empty => the whole day. */
  start: string;
  end: string;
  capacity: number | string;
}

export type CapacityModeInput = "PEOPLE" | "BOOKINGS";

export interface ServiceFormInput {
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  active: boolean;
  durationMinutes: number | string;
  bufferBeforeMinutes: number | string;
  bufferAfterMinutes: number | string;
  /** Empty string or null => step by duration. */
  slotIntervalMinutes: number | string | null;
  leadTimeMinutes: number | string;
  maxAdvanceDays: number | string;
  capacityPerSlot: number | string;
  /** What slot limits count: people (seats) or bookings. */
  capacityMode: CapacityModeInput;
  minSeatsPerBooking: number | string;
  /** Empty string or null => no per-booking maximum. */
  maxSeatsPerBooking: number | string | null;
  /** Empty string or null => use the shop's timezone. */
  timezone: string | null;
  windows: WindowInput[];
  /** Different slot limits on specific dates. */
  capacityOverrides: OverrideInput[];
  /** Asked in the booking popup's second step. */
  intakeQuestions: IntakeQuestion[];
  requireSignature: boolean;
  /** Variant GIDs offered as add-ons in the popup. */
  upsellVariantIds: string[];
  /** Product GIDs whose pages offer this service as an add-on. */
  addonProductIds?: string[];
  /** Add-on card wording; empty falls back to the service product's own. */
  addonLabel?: string | null;
  addonDescription?: string | null;
  addonBadge?: string | null;
}

export interface ServiceData {
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  active: boolean;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  slotIntervalMinutes: number | null;
  leadTimeMinutes: number;
  maxAdvanceDays: number;
  capacityPerSlot: number;
  capacityMode: CapacityModeInput;
  minSeatsPerBooking: number;
  maxSeatsPerBooking: number | null;
  timezone: string | null;
  windows: {
    dayOfWeek: number;
    startMinute: number;
    endMinute: number;
    capacity: number | null;
  }[];
  capacityOverrides: {
    date: string;
    startMinute: number | null;
    endMinute: number | null;
    capacity: number;
  }[];
  intakeQuestions: IntakeQuestion[];
  requireSignature: boolean;
  upsellVariantIds: string[];
  addonProductIds: string[];
  addonLabel: string | null;
  addonDescription: string | null;
  addonBadge: string | null;
}

/**
 * Field name => message. Row errors use `windows.<index>` and
 * `intakeQuestions.<index>`.
 */
export type ServiceErrors = Record<string, string>;

export type ParseResult =
  | { ok: true; data: ServiceData }
  | { ok: false; errors: ServiceErrors };

const MINUTES_PER_DAY = 24 * 60;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function parseServiceInput(input: ServiceFormInput): ParseResult {
  const errors: ServiceErrors = {};

  const int = (
    field: keyof ServiceFormInput,
    min: number,
    max: number,
    label: string,
  ): number => {
    const raw = input[field];
    const value = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (String(raw).trim() === "" || !Number.isInteger(value)) {
      errors[field] = `${label} must be a whole number.`;
    } else if (value < min || value > max) {
      errors[field] = `${label} must be between ${min} and ${max}.`;
    }
    return value;
  };

  if (!PRODUCT_GID.test(input.shopifyProductId ?? "")) {
    errors.shopifyVariantId = "Choose the product this service is sold as.";
  } else if (!VARIANT_GID.test(input.shopifyVariantId ?? "")) {
    errors.shopifyVariantId = "Choose a product variant.";
  }

  const title = (input.title ?? "").trim();
  if (!title) errors.title = "Title is required.";
  else if (title.length > 255) errors.title = "Title is too long.";

  const durationMinutes = int("durationMinutes", 5, MINUTES_PER_DAY, "Duration");
  const bufferBeforeMinutes = int("bufferBeforeMinutes", 0, 240, "Buffer before");
  const bufferAfterMinutes = int("bufferAfterMinutes", 0, 240, "Buffer after");
  const leadTimeMinutes = int("leadTimeMinutes", 0, 60 * 24 * 30, "Minimum notice");
  const maxAdvanceDays = int("maxAdvanceDays", 1, 365, "Booking window");
  const capacityMode: CapacityModeInput =
    input.capacityMode === "BOOKINGS" ? "BOOKINGS" : "PEOPLE";
  const byBookings = capacityMode === "BOOKINGS";
  const capacityPerSlot = int(
    "capacityPerSlot",
    1,
    MAX_SEATS,
    byBookings ? "Bookings per slot" : "Customers per slot",
  );
  const minSeatsPerBooking = int("minSeatsPerBooking", 1, MAX_SEATS, "Minimum people");
  const maxSeatsPerBooking = optionalInt(input.maxSeatsPerBooking, 1, MAX_SEATS);
  if (maxSeatsPerBooking === "invalid") {
    errors.maxSeatsPerBooking = `Maximum people must be a whole number between 1 and ${MAX_SEATS}, or empty.`;
  } else if (
    maxSeatsPerBooking !== null &&
    !errors.minSeatsPerBooking &&
    maxSeatsPerBooking < minSeatsPerBooking
  ) {
    errors.maxSeatsPerBooking = "Maximum people can't be less than the minimum.";
  }
  // In people mode a party bigger than every slot limit could never book.
  // Checked after windows/overrides are parsed, against the largest limit.
  const largestLimit: number[] = [capacityPerSlot];

  let slotIntervalMinutes: number | null = null;
  if (
    input.slotIntervalMinutes !== null &&
    String(input.slotIntervalMinutes).trim() !== ""
  ) {
    slotIntervalMinutes = int("slotIntervalMinutes", 5, MINUTES_PER_DAY, "Slot interval");
  }

  const timezone = input.timezone?.trim() || null;
  if (timezone && !isValidTimeZone(timezone)) {
    errors.timezone = "Unknown timezone.";
  }

  const windows: ServiceData["windows"] = [];
  // Row each parsed window came from, so errors land on the row the merchant sees.
  const sourceRow: number[] = [];
  (input.windows ?? []).forEach((w, index) => {
    const key = `windows.${index}`;
    const start = parseHhMm(w.start);
    const endRaw = parseHhMm(w.end);
    if (!Number.isInteger(w.dayOfWeek) || w.dayOfWeek < 0 || w.dayOfWeek > 6) {
      errors[key] = "Invalid day.";
      return;
    }
    if (start === null || endRaw === null) {
      errors[key] = "Use a valid time.";
      return;
    }
    // A closing time of 00:00 means "until midnight".
    const end = endRaw === 0 ? MINUTES_PER_DAY : endRaw;
    if (end <= start) {
      errors[key] = "Closing time must be after opening time.";
      return;
    }
    if (!errors.durationMinutes && end - start < durationMinutes) {
      errors[key] = "These hours are shorter than the service, so no slots fit.";
      return;
    }
    const capacity = optionalInt(w.capacity, 1, MAX_SEATS);
    if (capacity === "invalid") {
      errors[key] = `Limit must be a whole number between 1 and ${MAX_SEATS}, or empty.`;
      return;
    }
    if (capacity !== null) largestLimit.push(capacity);
    windows.push({ dayOfWeek: w.dayOfWeek, startMinute: start, endMinute: end, capacity });
    sourceRow.push(index);
  });

  // Overlaps are checked per day after sorting. The message lands on the later
  // window in the merchant's original order, which is the one they just added.
  const indexed = windows.map((w, i) => ({ ...w, row: sourceRow[i] }));
  for (let day = 0; day < 7; day++) {
    const sameDay = indexed
      .filter((w) => w.dayOfWeek === day)
      .sort((a, b) => a.startMinute - b.startMinute);
    for (let k = 1; k < sameDay.length; k++) {
      if (sameDay[k].startMinute < sameDay[k - 1].endMinute) {
        const later = Math.max(sameDay[k].row, sameDay[k - 1].row);
        errors[`windows.${later}`] = `Overlaps other ${DAY_NAMES[day]} hours.`;
      }
    }
  }

  const capacityOverrides: ServiceData["capacityOverrides"] = [];
  const rawOverrides = input.capacityOverrides ?? [];
  if (rawOverrides.length > MAX_OVERRIDES) {
    errors.capacityOverrides = `Up to ${MAX_OVERRIDES} date-specific limits.`;
  }
  rawOverrides.slice(0, MAX_OVERRIDES).forEach((o, index) => {
    const key = `capacityOverrides.${index}`;
    const date = (o.date ?? "").trim();
    if (!isValidDate(date)) {
      errors[key] = "Choose a date.";
      return;
    }
    const startText = (o.start ?? "").trim();
    const endText = (o.end ?? "").trim();
    let startMinute: number | null = null;
    let endMinute: number | null = null;
    if (startText || endText) {
      const start = parseHhMm(startText);
      const endRaw = parseHhMm(endText);
      if (start === null || endRaw === null) {
        errors[key] = "Use a valid time for both From and To, or leave both empty for the whole day.";
        return;
      }
      const end = endRaw === 0 ? MINUTES_PER_DAY : endRaw;
      if (end <= start) {
        errors[key] = "To must be after From.";
        return;
      }
      startMinute = start;
      endMinute = end;
    }
    const capacity = optionalInt(o.capacity, 1, MAX_SEATS);
    if (capacity === null || capacity === "invalid") {
      errors[key] = `Limit must be a whole number between 1 and ${MAX_SEATS}.`;
      return;
    }
    largestLimit.push(capacity);
    capacityOverrides.push({ date, startMinute, endMinute, capacity });
  });

  if (
    !byBookings &&
    !errors.capacityPerSlot &&
    !errors.minSeatsPerBooking &&
    minSeatsPerBooking > Math.max(...largestLimit)
  ) {
    errors.minSeatsPerBooking = "Minimum people is more than any slot allows, so nobody could book.";
  }

  const intakeQuestions: IntakeQuestion[] = [];
  const questionIds = new Set<string>();
  const rawQuestions = input.intakeQuestions ?? [];
  if (rawQuestions.length > MAX_QUESTIONS) {
    errors.intakeQuestions = `Up to ${MAX_QUESTIONS} questions.`;
  }
  rawQuestions.slice(0, MAX_QUESTIONS).forEach((q, index) => {
    const key = `intakeQuestions.${index}`;
    const label = (q.label ?? "").trim();
    const help = (q.help ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(q.id ?? "") || questionIds.has(q.id)) {
      errors[key] = "Invalid question.";
    } else if (q.type !== "text" && q.type !== "checkbox") {
      errors[key] = "Choose a question type.";
    } else if (!label) {
      errors[key] = "Question text is required.";
    } else if (label.length > MAX_LABEL) {
      errors[key] = `Question text must be under ${MAX_LABEL} characters.`;
    } else if (help.length > MAX_HELP) {
      errors[key] = `Help text must be under ${MAX_HELP} characters.`;
    } else {
      questionIds.add(q.id);
      intakeQuestions.push({
        id: q.id,
        type: q.type,
        label,
        ...(help ? { help } : {}),
        required: q.required === true,
      });
    }
  });

  const upsellVariantIds = [...new Set(input.upsellVariantIds ?? [])];
  if (upsellVariantIds.length > MAX_UPSELLS) {
    errors.upsellVariantIds = `Up to ${MAX_UPSELLS} add-on products.`;
  } else if (upsellVariantIds.some((id) => !VARIANT_GID.test(id))) {
    errors.upsellVariantIds = "Choose add-on products from this store.";
  } else if (upsellVariantIds.includes(input.shopifyVariantId)) {
    errors.upsellVariantIds = "A service can't be its own add-on.";
  }

  const addonProductIds = [...new Set(input.addonProductIds ?? [])];
  if (addonProductIds.length > MAX_ADDON_PRODUCTS) {
    errors.addonProductIds = `Up to ${MAX_ADDON_PRODUCTS} products.`;
  } else if (addonProductIds.some((id) => !PRODUCT_GID.test(id))) {
    errors.addonProductIds = "Choose products from this store.";
  } else if (input.shopifyProductId && addonProductIds.includes(input.shopifyProductId)) {
    errors.addonProductIds = "A service can't be offered as an add-on on its own product.";
  }

  // Blank means "fall back to the product's own title and description", so an
  // empty field is valid; only the length is checked.
  const addonLabel = (input.addonLabel ?? "").trim() || null;
  if (addonLabel && addonLabel.length > MAX_ADDON_LABEL) {
    errors.addonLabel = `Keep the label under ${MAX_ADDON_LABEL} characters.`;
  }
  const addonDescription = (input.addonDescription ?? "").trim() || null;
  if (addonDescription && addonDescription.length > MAX_ADDON_DESCRIPTION) {
    errors.addonDescription = `Keep the description under ${MAX_ADDON_DESCRIPTION} characters.`;
  }
  const addonBadge = (input.addonBadge ?? "").trim() || null;
  if (addonBadge && addonBadge.length > MAX_ADDON_BADGE) {
    errors.addonBadge = `Keep the badge under ${MAX_ADDON_BADGE} characters.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    data: {
      shopifyProductId: input.shopifyProductId,
      shopifyVariantId: input.shopifyVariantId,
      title,
      active: Boolean(input.active),
      durationMinutes,
      bufferBeforeMinutes,
      bufferAfterMinutes,
      slotIntervalMinutes,
      leadTimeMinutes,
      maxAdvanceDays,
      capacityPerSlot,
      capacityMode,
      minSeatsPerBooking,
      maxSeatsPerBooking: maxSeatsPerBooking as number | null,
      timezone,
      windows,
      capacityOverrides,
      intakeQuestions,
      requireSignature: Boolean(input.requireSignature),
      upsellVariantIds,
      addonProductIds,
      addonLabel,
      addonDescription,
      addonBadge,
    },
  };
}

/** Minutes from midnight => "HH:MM". 1440 renders as "00:00" (midnight close). */
export function minutesToHhMm(minutes: number): string {
  const m = minutes % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function parseHhMm(value: string | undefined): number | null {
  const match = HHMM.exec((value ?? "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * An optional whole number: empty/null => null, out of range or not whole =>
 * "invalid".
 */
function optionalInt(
  raw: number | string | null | undefined,
  min: number,
  max: number,
): number | null | "invalid" {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value < min || value > max) return "invalid";
  return value;
}

/** A real calendar date written as YYYY-MM-DD. */
function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return d.toISOString().slice(0, 10) === value;
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
