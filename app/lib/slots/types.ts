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
  capacityPerSlot: number;
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
}

/** A half-open UTC interval: [startsAt, endsAt). */
export interface Interval {
  startsAt: Date;
  endsAt: Date;
}

/** How many live holds + confirmed bookings already sit on a slot start. */
export interface SlotUsage {
  startsAt: Date;
  count: number;
}

export interface Slot {
  /** UTC instant the appointment begins. */
  startsAt: Date;
  /** UTC instant the appointment ends (excludes buffers). */
  endsAt: Date;
  /** Capacity still available. Always >= 1 for returned slots. */
  remaining: number;
}

export interface ComputeSlotsParams {
  service: ServiceGeometry;
  windows: WeeklyWindow[];
  /** Blackouts already narrowed to this service (shop-wide ones merged in). */
  blackouts: Interval[];
  usage: SlotUsage[];
  /** Inclusive UTC lower bound of the query range. */
  rangeStart: Date;
  /** Exclusive UTC upper bound of the query range. */
  rangeEnd: Date;
  now: Date;
}
