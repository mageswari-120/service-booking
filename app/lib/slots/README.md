# Slot engine

Pure slot arithmetic. No database, no Shopify calls, no clock reads — `now` is
always injected, so the proxy, the orders webhook and the tests all agree.

## Entry points

| Function | Used by |
|---|---|
| `computeSlots` | `/apps/booking/slots` — slot list for one day |
| `bookableDays` | `/apps/booking/availability` — which days the month view enables |
| `isOfferedSlot` | `orders/create` — re-validate the customer-supplied instant |

## Time handling

Every `Date` crossing this module's boundary is a **UTC instant**. Wall-clock
arithmetic happens in the service timezone (`Service.timezone ?? Shop.timezone`)
and is converted at the edges by `localToUtc`.

Two DST cases are handled deliberately:

- **Spring forward (nonexistent wall time).** Luxon shifts a nonexistent local
  time forward onto the next valid instant, which would invent a slot the
  merchant never opened. `localToUtc` compares the resulting wall time against
  the requested one and returns `null` on a mismatch, so the slot is skipped.
- **Autumn fall-back (ambiguous wall time).** The hour occurs twice. We take
  the first/earlier offset — Luxon's default, and the conventional choice for
  scheduling.

## Buffers vs. the opening window — a decision, not an accident

**The appointment must fit inside the opening window. Its buffers may spill
past the window edges.**

A 9:00–17:00 window with a 60-minute service and a 15-minute trailing buffer
therefore offers a first slot at 9:00 and a last slot at 16:00 — not 9:15 and
15:45. Merchants set a window meaning "I am open from 9", and the stricter
reading surprises them every time.

Buffers still do their job: the *buffered* span
`[start - bufferBefore, start + duration + bufferAfter)` is what gets checked
against blackouts, so a buffer that reaches past the window into a blackout
does remove the slot. Buffers shape spacing and conflicts, not window fit.

## Capacity

`remaining = capacity - (live holds + confirmed bookings at that start)`.

A slot's `capacity` is, most specific first: a date override on that local
date (whole day, or a minute range containing the start), then the weekly
window's own `capacity`, then `capacityPerSlot` (see `capacityAt`).

Usage is in the service's units: seats in PEOPLE mode, bookings in BOOKINGS
mode. Only slots with `remaining >= minUnitsPerHold` (the smallest allowed
booking) are returned. The caller supplies `usage`; the engine never counts
for itself. The authoritative capacity check is the
transaction in the hold manager — the engine's count is for display, and is
already stale by the time the customer reads it.
