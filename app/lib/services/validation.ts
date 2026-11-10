/**
 * Validation for the merchant's service form.
 *
 * Pure: no database, no Shopify. The admin route parses the submitted JSON
 * through `parseServiceInput` and either saves the result or hands the error
 * map straight back to the form, keyed by field so Polaris can show each
 * message under its own input.
 */

export interface WindowInput {
  dayOfWeek: number;
  /** "HH:MM", 24-hour, service-local. */
  start: string;
  /** "HH:MM". "00:00" as an end time means midnight at the end of the day. */
  end: string;
}

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
  /** Empty string or null => use the shop's timezone. */
  timezone: string | null;
  windows: WindowInput[];
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
  timezone: string | null;
  windows: { dayOfWeek: number; startMinute: number; endMinute: number }[];
}

/** Field name => message. Window errors use the key `windows.<index>`. */
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
  const capacityPerSlot = int("capacityPerSlot", 1, 1000, "Capacity");

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
    windows.push({ dayOfWeek: w.dayOfWeek, startMinute: start, endMinute: end });
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
      timezone,
      windows,
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

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
