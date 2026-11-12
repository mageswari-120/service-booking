/**
 * Reading the booking line items out of an orders/create payload. Pure (no DB)
 * so it is unit-tested in order.test.ts.
 *
 * The storefront widget (storefront/booking-step2.js) adds each booking to the
 * cart with these line item properties: `_booking_hold` (signed hold token),
 * `_booking_start` (ISO start) and `_booking_seats`.
 */

export interface OrderPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  email?: string | null;
  contact_email?: string | null;
  phone?: string | null;
  customer?: {
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
  } | null;
  billing_address?: { first_name?: string | null; last_name?: string | null; phone?: string | null } | null;
  line_items?: {
    id?: number | string;
    variant_id?: number | string | null;
    properties?: { name?: string; value?: unknown }[] | null;
  }[];
}

export interface BookingLine {
  lineItemId: string;
  variantId: string | null;
  holdToken: string | null;
  start: Date | null;
  seats: number;
}

export interface OrderCustomer {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** Line items that carry a booking (a `_booking_hold` or `_booking_start`). */
export function bookingLines(order: OrderPayload): BookingLine[] {
  const out: BookingLine[] = [];
  for (const item of order.line_items ?? []) {
    const props: Record<string, string> = {};
    for (const p of item.properties ?? []) {
      if (p && typeof p.name === "string" && p.value != null) props[p.name] = String(p.value);
    }
    const holdToken = props._booking_hold?.trim() || null;
    const startRaw = props._booking_start?.trim();
    if (!holdToken && !startRaw) continue;
    if (item.id == null) continue;

    const start = startRaw ? new Date(startRaw) : null;
    const seats = Number(props._booking_seats);
    out.push({
      lineItemId: String(item.id),
      variantId: item.variant_id != null ? String(item.variant_id) : null,
      holdToken,
      start: start && !Number.isNaN(start.getTime()) ? start : null,
      seats: Number.isInteger(seats) && seats > 0 ? seats : 1,
    });
  }
  return out;
}

export function orderCustomer(order: OrderPayload): OrderCustomer {
  const c = order.customer ?? {};
  const b = order.billing_address ?? {};
  const join = (first?: string | null, last?: string | null) =>
    [first, last].filter((s) => s && s.trim()).join(" ").trim() || null;
  return {
    name: join(c.first_name, c.last_name) ?? join(b.first_name, b.last_name),
    email: order.email || order.contact_email || c.email || null,
    phone: order.phone || c.phone || b.phone || null,
  };
}
