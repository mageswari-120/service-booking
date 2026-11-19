import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
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
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getOrCreateShop } from "../lib/shop.server";

/** Longest staff name; it is shown on chips in the booking popup. */
const MAX_NAME = 60;
/** Most staff one shop can add. */
const MAX_STAFF = 100;

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
      services: { select: { service: { select: { title: true } } } },
      _count: { select: { bookings: true } },
    },
  });
  return {
    staff: staff.map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
      services: s.services.map((x) => x.service.title).sort(),
      bookings: s._count.bookings,
    })),
  };
};

type ActionResult = { ok: true; intent: string } | { ok: false; id?: string; error: string };

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
    await db.staff.update({
      where: { id },
      data: { name, active: form.get("active") === "true" },
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
                  page, under “Staff”. Staff work their services&apos; hours; one
                  person can&apos;t be booked for overlapping times.
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

function StaffRow({
  member,
}: {
  member: { id: string; name: string; active: boolean; services: string[]; bookings: number };
}) {
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();
  const [name, setName] = useState(member.name);
  const [active, setActive] = useState(member.active);

  useEffect(() => {
    setName(member.name);
    setActive(member.active);
  }, [member.name, member.active]);

  const busy = fetcher.state !== "idle";
  const intent = fetcher.formData?.get("intent");
  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.error : undefined;
  const dirty = name.trim() !== member.name || active !== member.active;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data.intent === "update") {
      shopify.toast.show("Staff member saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <Card>
      <BlockStack gap="300">
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
            onClick={() =>
              fetcher.submit(
                { intent: "update", id: member.id, name, active: String(active) },
                { method: "post" },
              )
            }
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
        {error ? <InlineError message={error} fieldID={`staff-${member.id}`} /> : null}
      </BlockStack>
    </Card>
  );
}
