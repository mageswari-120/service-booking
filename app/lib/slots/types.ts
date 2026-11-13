/** Slot geometry for one service. All durations are minutes. */
export interface ServiceGeometry {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** Step between candidate starts. Falls back to durationMinutes when null. */
  slotIntervalMinutes: number | null;
  /** A slot must start at least this far in the future. */
  leadTimeMinutes: number;
  /** A slot must start within this many days of now. */
  maxAdvanceDays: number;
  /** Default slot limit; a weekly window or date override can replace it. */
  capacityPerSlot: number;
  /**
   * Smallest number of capacity units one hold can take. A slot with fewer
   * units left is not offered. PEOPLE mode: the minimum party size;
   * BOOKINGS mode: 1. Defaults to 1.
   */
  minUnitsPerHold?: number;
  /** IANA zone, e.g. "Asia/Kolkata". Service override, else the shop's. */
  timezone: string;
}

/** A recurring weekly opening, in minutes from local midnight. */
export interface WeeklyWindow {
  /** 0 = Sunday ... 6 = Saturday, in the service timezone. */
  dayOfWeek: number;
  /** Inclusive. */
  startMinute: number;
  /** Exclusive. */
  endMinute: number;
  /** Slot limit inside this window. Null/absent => service.capacityPerSlot. */
  capacity?: number | null;
}

/**
 * A different slot limit on one local date. With no minute range it covers
 * the whole day; otherwise slots starting in [startMinute, endMinute).
 */
export interface CapacityOverride {
  /** "YYYY-MM-DD" in the service timezone. */
  date: string;
  startMinute: number | null;
  endMinute: number | null;
  capacity: number;
}

/** A half-open UTC interval: [startsAt, endsAt). */
export interface Interval {
  startsAt: Date;
  endsAt: Date;
}

/**
 * Capacity units already used at a slot start by live holds + confirmed
 * bookings: seats in PEOPLE mode, bookings in BOOKINGS mode.
 */
export interface SlotUsage {
  startsAt: Date;
  count: number;
}

export interface Slot {
  /** UTC instant the appointment begins. */
  startsAt: Date;
  /** UTC instant the appointment ends (excludes buffers). */
  endsAt: Date;
  /** This slot's limit (after weekly/date overrides). */
  capacity: number;
  /** Capacity still available. Always >= minUnitsPerHold for returned slots. */
  remaining: number;
}

export interface ComputeSlotsParams {
  service: ServiceGeometry;
  windows: WeeklyWindow[];
  /** Blackouts already narrowed to this service (shop-wide ones merged in). */
  blackouts: Interval[];
  usage: SlotUsage[];
  /** Date-specific limits. The first match wins. */
  overrides?: CapacityOverride[];
  /** Inclusive UTC lower bound of the query range. */
  rangeStart: Date;
  /** Exclusive UTC upper bound of the query range. */
  rangeEnd: Date;
  now: Date;
  /**
   * Also return slots that can't take a booking (full, or fewer places left
   * than one booking needs), with `remaining: 0`, so the storefront can show
   * them as booked out. Display only: never use this for validation.
   */
  includeFull?: boolean;
}
