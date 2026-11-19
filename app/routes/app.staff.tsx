import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Prisma } from "@prisma/client";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Checkbox,
  EmptyState,
  InlineError,
  InlineStack,
  Layout,
  Page,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getOrCreateShop } from "../lib/shop.server";
import {
  DAY_NAMES,
  minutesToHhMm,
  parseStaffSchedule,
  readStaffSchedule,
  type StaffScheduleInput,
} from "../lib/services/validation";

/** Longest staff name; it is shown on chips in the booking popup. */
const MAX_NAME = 60;
/** Most staff one shop can add. */
const MAX_STAFF = 100;

/** One row of the weekly hours editor (one time range per day). */
type DayRow = { on: boolean; start: string; end: string };

type Member = {
  id: string;
  name: string;
  active: boolean;
  services: string[];
  bookings: number;
  /** Null: works the service's hours. */
  days: DayRow[] | null;
  daysOff: string[];
};

/** Default custom hours: Mon–Sat 10:00–18:00. */
const DEFAULT_DAYS: DayRow[] = DAY_NAMES.map((_, d) => ({
  on: d !== 0,
  start: "10:00",
  end: "18:00",
}));

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop, admin);
  const staff = await db.staff.findMany({
    where: { shopId: shop.id },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      active: true,
      hours: true,
      daysOff: true,
      services: { select: { service: { select: { title: true } } } },
      _count: { select: { bookings: true } },
    },
  });
  return {
    staff: staff.map((s): Member => {
      const schedule = readStaffSchedule(s.hours, s.daysOff);
      return {
        id: s.id,
        name: s.name,
        active: s.active,
        services: s.services.map((x) => x.service.title).sort(),
        bookings: s._count.bookings,
        days: schedule.hours
          ? DAY_NAMES.map((_, d) => {
              const h = schedule.hours!.find((w) => w.dayOfWeek === d);
              return h
                ? { on: true, start: minutesToHhMm(h.startMinute), end: minutesToHhMm(h.endMinute) }
                : { on: false, start: "10:00", end: "18:00" };
            })
          : null,
        daysOff: schedule.daysOff,
      };
    }),
  };
};

type ActionResult =
  | { ok: true; intent: string }
  | { ok: false; id?: string; error: string; field?: "hours" | "daysOff" };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  const name = String(form.get("name") ?? "").trim();

  const checkName = (): string | null =>
    !name ? "Enter a name." : name.length > MAX_NAME ? `Keep names under ${MAX_NAME} characters.` : null;

  if (intent === "create") {
    const error = checkName();
    if (error) return { ok: false, error } satisfies ActionResult;
    const count = await db.staff.count({ where: { shopId: shop.id } });
    if (count >= MAX_STAFF) {
      return { ok: false, error: `Up to ${MAX_STAFF} staff.` } satisfies ActionResult;
    }
    await db.staff.create({ data: { shopId: shop.id, name, sortOrder: count } });
    return { ok: true, intent } satisfies ActionResult;
  }

  const existing = await db.staff.findFirst({
    where: { id, shopId: shop.id },
    select: { id: true, _count: { select: { bookings: true } } },
  });
  if (!existing) return { ok: false, id, error: "Staff member not found." } satisfies ActionResult;

  if (intent === "update") {
    const error = checkName();
    if (error) return { ok: false, id, error } satisfies ActionResult;
    let input: StaffScheduleInput;
    try {
      input = {
        hours: JSON.parse(String(form.get("hours") ?? "null")),
        daysOff: JSON.parse(String(form.get("daysOff") ?? "[]")),
      };
    } catch {
      return { ok: false, id, error: "Couldn't read the schedule. Reload and try again." } satisfies ActionResult;
    }
    const schedule = parseStaffSchedule(input);
    if (!schedule.ok) {
      const field = schedule.errors.hours ? "hours" : "daysOff";
      return { ok: false, id, field, error: schedule.errors[field] } satisfies ActionResult;
    }
    await db.staff.update({
      where: { id },
      data: {
        name,
        active: form.get("active") === "true",
        hours: schedule.data.hours ?? Prisma.DbNull,
        daysOff: schedule.data.daysOff.length ? schedule.data.daysOff : Prisma.DbNull,
      },
    });
    return { ok: true, intent } satisfies ActionResult;
  }

  if (intent === "delete") {
    // Deleting would strip the name off their past appointments; turning
    // them off keeps the history.
    if (existing._count.bookings > 0) {
      return {
        ok: false,
        id,
        error: "This person has bookings, so they can't be deleted. Untick “Can be booked” instead.",
      } satisfies ActionResult;
    }
    await db.staff.delete({ where: { id } });
    return { ok: true, intent } satisfies ActionResult;
  }

  return { ok: false, error: "Unknown action." } satisfies ActionResult;
};

export default function StaffPage() {
  const { staff } = useLoaderData<typeof loader>();
  const create = useFetcher<ActionResult>();
  const shopify = useAppBridge();
  const [name, setName] = useState("");

  const adding = create.state !== "idle";
  const createError = create.data && !create.data.ok ? create.data.error : undefined;

  useEffect(() => {
    if (create.state === "idle" && create.data?.ok) {
      setName("");
      shopify.toast.show("Staff member added");
    }
  }, [create.state, create.data, shopify]);

  const add = () => create.submit({ intent: "create", name }, { method: "post" });

  return (
    <Page title="Staff" backAction={{ content: "Services", url: "/app" }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="p" tone="subdued">
                  People or resources (stylists, rooms, equipment…) customers
                  can book. Choose who performs each service on the service
                  page, under “Staff”. Each person works their services&apos;
                  hours, or their own hours if you set them below, and can
                  take days off. One person can&apos;t be booked for
                  overlapping times; “Any available” goes to whoever has the
                  fewest bookings that day.
                </Text>
                <InlineStack gap="200" blockAlign="end" wrap={false}>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Name"
                      value={name}
                      onChange={setName}
                      autoComplete="off"
                      maxLength={MAX_NAME}
                      placeholder="e.g. Person 1"
                      error={createError}
                    />
                  </div>
                  <Button variant="primary" onClick={add} loading={adding} disabled={!name.trim()}>
                    Add staff
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {staff.length ? (
              staff.map((s) => <StaffRow key={s.id} member={s} />)
            ) : (
              <Card>
                <EmptyState heading="No staff yet" image="">
                  <p>Add the people customers can choose between when they book.</p>
                </EmptyState>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function StaffRow({ member }: { member: Member }) {
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();
  const [name, setName] = useState(member.name);
  const [active, setActive] = useState(member.active);
  const [days, setDays] = useState<DayRow[] | null>(member.days);
  const [daysOff, setDaysOff] = useState<string[]>(member.daysOff);
  const [newDay, setNewDay] = useState("");

  // Reset to the saved values when they change (not on every revalidation,
  // which would wipe unsaved edits in other cards).
  const saved = JSON.stringify(member);
  useEffect(() => {
    const m = JSON.parse(saved) as Member;
    setName(m.name);
    setActive(m.active);
    setDays(m.days);
    setDaysOff(m.daysOff);
  }, [saved]);

  const busy = fetcher.state !== "idle";
  const intent = fetcher.formData?.get("intent");
  const failed = fetcher.data && !fetcher.data.ok ? fetcher.data : null;
  const dirty = useMemo(
    () =>
      name.trim() !== member.name ||
      active !== member.active ||
      JSON.stringify(days) !== JSON.stringify(member.days) ||
      JSON.stringify(daysOff) !== JSON.stringify(member.daysOff),
    [name, active, days, daysOff, member],
  );

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data.intent === "update") {
      shopify.toast.show("Staff member saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const setDay = (d: number, patch: Partial<DayRow>) =>
    setDays((rows) => (rows ? rows.map((r, i) => (i === d ? { ...r, ...patch } : r)) : rows));

  const addDayOff = () => {
    if (!newDay || daysOff.includes(newDay)) return;
    setDaysOff([...daysOff, newDay].sort());
    setNewDay("");
  };

  const save = () =>
    fetcher.submit(
      {
        intent: "update",
        id: member.id,
        name,
        active: String(active),
        hours: JSON.stringify(
          days
            ? days
                .map((r, d) => ({ dayOfWeek: d, start: r.start, end: r.end, on: r.on }))
                .filter((r) => r.on)
                .map(({ dayOfWeek, start, end }) => ({ dayOfWeek, start, end }))
            : null,
        ),
        daysOff: JSON.stringify(daysOff),
      },
      { method: "post" },
    );

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack gap="200" blockAlign="end" wrap={false}>
          <div style={{ flex: 1 }}>
            <TextField
              label="Name"
              labelHidden
              value={name}
              onChange={setName}
              autoComplete="off"
              maxLength={MAX_NAME}
            />
          </div>
          <Button
            variant="primary"
            onClick={save}
            disabled={!dirty || !name.trim()}
            loading={busy && intent === "update"}
          >
            Save
          </Button>
          <Button
            tone="critical"
            variant="tertiary"
            onClick={() => fetcher.submit({ intent: "delete", id: member.id }, { method: "post" })}
            loading={busy && intent === "delete"}
          >
            Delete
          </Button>
        </InlineStack>
        <Checkbox label="Can be booked" checked={active} onChange={setActive} />
        <InlineStack gap="200" blockAlign="center">
          {member.services.length ? (
            member.services.map((t) => <Badge key={t}>{t}</Badge>)
          ) : (
            <Text as="span" tone="subdued">
              Not assigned to any service yet.
            </Text>
          )}
          {member.bookings ? (
            <Text as="span" tone="subdued">
              · {member.bookings} booking{member.bookings === 1 ? "" : "s"}
            </Text>
          ) : null}
        </InlineStack>

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            Working hours
          </Text>
          <Checkbox
            label="Own working hours"
            helpText={
              days
                ? "Bookable only inside these hours (and the service's opening hours). Times are in the service's timezone."
                : "Off: they can be booked whenever the service is open."
            }
            checked={days !== null}
            onChange={(on) => setDays(on ? (member.days ?? DEFAULT_DAYS) : null)}
          />
          {days ? (
            <BlockStack gap="150">
              {days.map((r, d) => (
                <InlineStack key={DAY_NAMES[d]} gap="200" blockAlign="center" wrap={false}>
                  <div style={{ width: "8.5rem" }}>
                    <Checkbox label={DAY_NAMES[d]} checked={r.on} onChange={(on) => setDay(d, { on })} />
                  </div>
                  <div style={{ width: "8rem" }}>
                    <TextField
                      label={`${DAY_NAMES[d]} start`}
                      labelHidden
                      type="time"
                      value={r.start}
                      onChange={(start) => setDay(d, { start })}
                      autoComplete="off"
                      disabled={!r.on}
                    />
                  </div>
                  <Text as="span" tone="subdued">
                    to
                  </Text>
                  <div style={{ width: "8rem" }}>
                    <TextField
                      label={`${DAY_NAMES[d]} end`}
                      labelHidden
                      type="time"
                      value={r.end}
                      onChange={(end) => setDay(d, { end })}
                      autoComplete="off"
                      disabled={!r.on}
                    />
                  </div>
                  {!r.on ? (
                    <Text as="span" tone="subdued">
                      Off
                    </Text>
                  ) : null}
                </InlineStack>
              ))}
            </BlockStack>
          ) : null}
          {failed?.field === "hours" ? (
            <InlineError message={failed.error} fieldID={`staff-hours-${member.id}`} />
          ) : null}
        </BlockStack>

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            Days off
          </Text>
          <InlineStack gap="200" blockAlign="end" wrap={false}>
            <div style={{ width: "12rem" }}>
              <TextField
                label="Add a day off"
                labelHidden
                type="date"
                value={newDay}
                onChange={setNewDay}
                autoComplete="off"
              />
            </div>
            <Button onClick={addDayOff} disabled={!newDay}>
              Add day off
            </Button>
          </InlineStack>
          {daysOff.length ? (
            <InlineStack gap="150">
              {daysOff.map((d) => (
                <Tag key={d} onRemove={() => setDaysOff(daysOff.filter((x) => x !== d))}>
                  {d}
                </Tag>
              ))}
            </InlineStack>
          ) : (
            <Text as="p" tone="subdued">
              No days off. Customers can&apos;t book this person on a day off.
            </Text>
          )}
          {failed?.field === "daysOff" ? (
            <InlineError message={failed.error} fieldID={`staff-days-off-${member.id}`} />
          ) : null}
        </BlockStack>

        {failed && !failed.field ? (
          <InlineError message={failed.error} fieldID={`staff-${member.id}`} />
        ) : null}
      </BlockStack>
    </Card>
  );
}
