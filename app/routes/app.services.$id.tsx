import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  BlockStack,
  Button,
  Card,
  Checkbox,
  FormLayout,
  InlineError,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Prisma } from "@prisma/client";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getOrCreateShop } from "../lib/shop.server";
import {
  fetchVariant,
  markVariantAsService,
  setVariantBookable,
  setVariantUpsells,
} from "../lib/services/shopify.server";
import { parseQuestions, type IntakeQuestion } from "../lib/booking/details";
import {
  DAY_NAMES,
  MAX_UPSELLS,
  minutesToHhMm,
  parseServiceInput,
  MAX_OVERRIDES,
  type CapacityModeInput,
  type OverrideInput,
  type ServiceErrors,
  type ServiceFormInput,
  type WindowInput,
} from "../lib/services/validation";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop, admin);

  const timezones = (
    Intl as unknown as { supportedValuesOf(key: "timeZone"): string[] }
  ).supportedValuesOf("timeZone");

  if (params.id === "new") {
    return {
      isNew: true,
      shopTimezone: shop.timezone,
      timezones,
      variantLabel: null as string | null,
      upsellLabels: {} as Record<string, string>,
      form: emptyForm(),
    };
  }

  const service = await db.service.findFirst({
    where: { id: params.id, shopId: shop.id },
    include: {
      availabilityRules: { orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }] },
      capacityOverrides: { orderBy: [{ date: "asc" }, { startMinute: "asc" }] },
    },
  });
  if (!service) throw new Response("Service not found", { status: 404 });

  // Show the live product name; fall back to the stored title if the product
  // has since been deleted in Shopify.
  const upsellVariantIds = stringList(service.upsellVariantIds);
  const [variant, ...upsells] = await Promise.all(
    [service.shopifyVariantId, ...upsellVariantIds].map((id) => fetchVariant(admin, id)),
  );
  const upsellLabels: Record<string, string> = {};
  upsellVariantIds.forEach((id, i) => {
    upsellLabels[id] = upsells[i]?.displayName ?? "Product not found";
  });

  const form: ServiceFormInput = {
    shopifyProductId: service.shopifyProductId,
    shopifyVariantId: service.shopifyVariantId,
    title: service.title,
    active: service.active,
    durationMinutes: String(service.durationMinutes),
    bufferBeforeMinutes: String(service.bufferBeforeMinutes),
    bufferAfterMinutes: String(service.bufferAfterMinutes),
    slotIntervalMinutes:
      service.slotIntervalMinutes === null ? "" : String(service.slotIntervalMinutes),
    leadTimeMinutes: String(service.leadTimeMinutes),
    maxAdvanceDays: String(service.maxAdvanceDays),
    capacityPerSlot: String(service.capacityPerSlot),
    capacityMode: service.capacityMode,
    minSeatsPerBooking: String(service.minSeatsPerBooking),
    maxSeatsPerBooking:
      service.maxSeatsPerBooking === null ? "" : String(service.maxSeatsPerBooking),
    timezone: service.timezone ?? "",
    windows: service.availabilityRules.map((r) => ({
      dayOfWeek: r.dayOfWeek,
      start: minutesToHhMm(r.startMinute),
      end: minutesToHhMm(r.endMinute),
      capacity: r.capacity === null ? "" : String(r.capacity),
    })),
    capacityOverrides: service.capacityOverrides.map((o) => ({
      date: o.date,
      start: o.startMinute === null ? "" : minutesToHhMm(o.startMinute),
      end: o.endMinute === null ? "" : minutesToHhMm(o.endMinute),
      capacity: String(o.capacity),
    })),
    intakeQuestions: parseQuestions(service.intakeQuestions),
    requireSignature: service.requireSignature,
    upsellVariantIds,
  };

  return {
    isNew: false,
    shopTimezone: shop.timezone,
    timezones,
    variantLabel: variant?.displayName ?? `${service.title} (product not found)`,
    upsellLabels,
    form,
  };
};

type ActionResult =
  | { ok: true; variantLabel: string }
  | { ok: false; errors: ServiceErrors };

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const formData = await request.formData();
  const intent = formData.get("intent");

  const existing =
    params.id === "new"
      ? null
      : await db.service.findFirst({
          where: { id: params.id, shopId: shop.id },
          select: {
            id: true,
            shopifyVariantId: true,
            _count: { select: { bookings: true } },
          },
        });
  if (params.id !== "new" && !existing) {
    throw new Response("Service not found", { status: 404 });
  }

  if (intent === "delete" && existing) {
    // Bookings cascade with their service, so deleting one with history would
    // silently erase customers' appointments. Deactivating keeps them.
    if (existing._count.bookings > 0) {
      return {
        ok: false,
        errors: {
          form: "This service has bookings, so it can't be deleted. Turn off \"Accept bookings\" instead.",
        },
      } satisfies ActionResult;
    }
    await db.service.delete({ where: { id: existing.id } });
    // Best effort: a stale flag only costs a proxy check on the storefront.
    await setVariantBookable(admin, existing.shopifyVariantId, false);
    return redirect("/app");
  }

  let input: ServiceFormInput;
  try {
    input = JSON.parse(String(formData.get("payload") ?? "")) as ServiceFormInput;
  } catch {
    return { ok: false, errors: { form: "Malformed form data." } } satisfies ActionResult;
  }

  // The product ID comes from Shopify, never from the browser.
  const variant = input.shopifyVariantId
    ? await fetchVariant(admin, input.shopifyVariantId)
    : null;
  if (!variant) {
    return {
      ok: false,
      errors: { shopifyVariantId: "Choose a product variant from this store." },
    } satisfies ActionResult;
  }
  input.shopifyProductId = variant.productId;

  const parsed = parseServiceInput(input);
  if (!parsed.ok) return { ok: false, errors: parsed.errors } satisfies ActionResult;
  const { windows, capacityOverrides, intakeQuestions, upsellVariantIds, ...rest } =
    parsed.data;
  const fields = {
    ...rest,
    intakeQuestions: intakeQuestions as unknown as Prisma.InputJsonValue,
    upsellVariantIds,
  };

  const shopifyError =
    (await markVariantAsService(admin, variant.productId, variant.variantId)) ??
    // Lets the theme show "Select a time" without waiting on the app proxy.
    (await setVariantBookable(admin, variant.variantId, fields.active));
  if (shopifyError) {
    return {
      ok: false,
      errors: { shopifyVariantId: `Shopify rejected the update: ${shopifyError}` },
    } satisfies ActionResult;
  }
  // The popup's add-ons, rendered by the theme block in Liquid.
  const upsellError = await setVariantUpsells(admin, variant.variantId, upsellVariantIds);
  if (upsellError) {
    return {
      ok: false,
      errors: { upsellVariantIds: `Shopify rejected the add-ons: ${upsellError}` },
    } satisfies ActionResult;
  }

  let serviceId: string;
  try {
    serviceId = await db.$transaction(async (tx) => {
      const service = existing
        ? await tx.service.update({ where: { id: existing.id }, data: fields })
        : await tx.service.create({ data: { ...fields, shopId: shop.id } });
      // Weekly hours are small and edited as a whole, so replace rather than diff.
      await tx.availabilityRule.deleteMany({ where: { serviceId: service.id } });
      if (windows.length > 0) {
        await tx.availabilityRule.createMany({
          data: windows.map((w) => ({ ...w, serviceId: service.id })),
        });
      }
      // Same for date-specific limits.
      await tx.capacityOverride.deleteMany({ where: { serviceId: service.id } });
      if (capacityOverrides.length > 0) {
        await tx.capacityOverride.createMany({
          data: capacityOverrides.map((o) => ({ ...o, serviceId: service.id })),
        });
      }
      return service.id;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return {
        ok: false,
        errors: { shopifyVariantId: "Another service already uses this variant." },
      } satisfies ActionResult;
    }
    throw error;
  }

  // Moved to another variant: the old one is no longer a service.
  if (existing && existing.shopifyVariantId !== variant.variantId) {
    await setVariantBookable(admin, existing.shopifyVariantId, false);
    await setVariantUpsells(admin, existing.shopifyVariantId, []);
  }

  if (!existing) return redirect(`/app/services/${serviceId}`);
  return { ok: true, variantLabel: variant.displayName } satisfies ActionResult;
};

function emptyForm(): ServiceFormInput {
  return {
    shopifyProductId: "",
    shopifyVariantId: "",
    title: "",
    active: true,
    durationMinutes: "60",
    bufferBeforeMinutes: "0",
    bufferAfterMinutes: "0",
    slotIntervalMinutes: "",
    leadTimeMinutes: "120",
    maxAdvanceDays: "60",
    capacityPerSlot: "1",
    capacityMode: "PEOPLE",
    minSeatsPerBooking: "1",
    maxSeatsPerBooking: "",
    timezone: "",
    // Mon–Fri 9–5 is the most common starting point; the merchant edits from here.
    windows: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      dayOfWeek,
      start: "09:00",
      end: "17:00",
    })),
    capacityOverrides: [],
    intakeQuestions: [],
    requireSignature: false,
    upsellVariantIds: [],
  };
}

/** A JSON column expected to hold string[]; anything else reads as empty. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** A fresh question row for the editor. */
function newQuestion(): IntakeQuestion {
  return {
    id: `q_${Math.random().toString(36).slice(2, 10)}`,
    type: "text",
    label: "",
    required: false,
  };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export default function ServiceEditor() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();

  const [form, setForm] = useState<ServiceFormInput>(loaderData.form);
  const [variantLabel, setVariantLabel] = useState(loaderData.variantLabel);
  const [upsellLabels, setUpsellLabels] = useState(loaderData.upsellLabels);

  // A save that redirects (create) reloads the loader; resync from it.
  useEffect(() => {
    setForm(loaderData.form);
    setVariantLabel(loaderData.variantLabel);
    setUpsellLabels(loaderData.upsellLabels);
  }, [loaderData]);

  const saving = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "save";
  const deleting =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "delete";
  const errors: ServiceErrors =
    fetcher.data && !fetcher.data.ok ? fetcher.data.errors : {};

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setVariantLabel(fetcher.data.variantLabel);
      shopify.toast.show("Service saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const set = useCallback(
    <K extends keyof ServiceFormInput>(key: K) =>
      (value: ServiceFormInput[K]) =>
        setForm((f) => ({ ...f, [key]: value })),
    [],
  );

  const pickVariant = async () => {
    const selection = (await shopify.resourcePicker({
      type: "variant",
      action: "select",
      multiple: false,
      selectionIds: form.shopifyVariantId ? [{ id: form.shopifyVariantId }] : [],
    })) as { id: string; title?: string; displayName?: string }[] | undefined;
    const picked = selection?.[0];
    if (!picked) return;
    const label = picked.displayName ?? picked.title ?? "Selected variant";
    setVariantLabel(label);
    setForm((f) => ({
      ...f,
      shopifyVariantId: picked.id,
      // Product ID is resolved on the server; clear any stale one.
      shopifyProductId: "",
      title: f.title || label,
    }));
  };

  const save = () =>
    fetcher.submit(
      { intent: "save", payload: JSON.stringify(form) },
      { method: "POST" },
    );
  const remove = () => fetcher.submit({ intent: "delete" }, { method: "POST" });

  const updateWindow = (index: number, patch: Partial<WindowInput>) =>
    setForm((f) => ({
      ...f,
      windows: f.windows.map((w, i) => (i === index ? { ...w, ...patch } : w)),
    }));
  const addWindow = (dayOfWeek: number) =>
    setForm((f) => ({
      ...f,
      windows: [...f.windows, { dayOfWeek, start: "09:00", end: "17:00" }],
    }));
  const updateOverride = (index: number, patch: Partial<OverrideInput>) =>
    setForm((f) => ({
      ...f,
      capacityOverrides: f.capacityOverrides.map((o, i) =>
        i === index ? { ...o, ...patch } : o,
      ),
    }));
  const addOverride = () =>
    setForm((f) => ({
      ...f,
      capacityOverrides: [
        ...f.capacityOverrides,
        { date: "", start: "", end: "", capacity: String(f.capacityPerSlot) },
      ],
    }));
  const removeOverride = (index: number) =>
    setForm((f) => ({
      ...f,
      capacityOverrides: f.capacityOverrides.filter((_, i) => i !== index),
    }));
  const removeWindow = (index: number) =>
    setForm((f) => ({ ...f, windows: f.windows.filter((_, i) => i !== index) }));

  const updateQuestion = (index: number, patch: Partial<IntakeQuestion>) =>
    setForm((f) => ({
      ...f,
      intakeQuestions: f.intakeQuestions.map((q, i) => (i === index ? { ...q, ...patch } : q)),
    }));
  const addQuestion = () =>
    setForm((f) => ({ ...f, intakeQuestions: [...f.intakeQuestions, newQuestion()] }));
  const removeQuestion = (index: number) =>
    setForm((f) => ({
      ...f,
      intakeQuestions: f.intakeQuestions.filter((_, i) => i !== index),
    }));

  const pickUpsells = async () => {
    const selection = (await shopify.resourcePicker({
      type: "variant",
      action: "select",
      multiple: MAX_UPSELLS,
      selectionIds: form.upsellVariantIds.map((id) => ({ id })),
    })) as { id: string; title?: string; displayName?: string }[] | undefined;
    if (!selection) return;
    const picked = selection.filter((v) => v.id !== form.shopifyVariantId);
    setUpsellLabels((labels) => {
      const next = { ...labels };
      for (const v of picked) next[v.id] = v.displayName ?? v.title ?? "Selected variant";
      return next;
    });
    setForm((f) => ({ ...f, upsellVariantIds: picked.map((v) => v.id) }));
  };
  const removeUpsell = (id: string) =>
    setForm((f) => ({ ...f, upsellVariantIds: f.upsellVariantIds.filter((v) => v !== id) }));

  const timezoneOptions = useMemo(
    () => [
      { label: `Store timezone (${loaderData.shopTimezone})`, value: "" },
      ...loaderData.timezones.map((tz) => ({ label: tz, value: tz })),
    ],
    [loaderData.shopTimezone, loaderData.timezones],
  );

  const duration = Number(form.durationMinutes) || 0;
  const byBookings = form.capacityMode === "BOOKINGS";

  return (
    <Page
      title={loaderData.isNew ? "New service" : form.title || "Service"}
      backAction={{ content: "Services", url: "/app" }}
      primaryAction={{ content: "Save", onAction: save, loading: saving }}
      secondaryActions={
        loaderData.isNew
          ? []
          : [
              {
                content: "Delete",
                destructive: true,
                icon: DeleteIcon,
                loading: deleting,
                onAction: remove,
              },
            ]
      }
    >
      <Layout>
        {errors.form ? (
          <Layout.Section>
            <InlineError message={errors.form} fieldID="form" />
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Product
                </Text>
                <Text as="p" tone="subdued">
                  Customers buy this variant to book. Its price is the price of
                  the appointment.
                </Text>
                <InlineStack gap="300" blockAlign="center">
                  <Text as="span" fontWeight="semibold">
                    {variantLabel ?? "No variant selected"}
                  </Text>
                  <Button onClick={pickVariant}>
                    {form.shopifyVariantId ? "Change" : "Choose variant"}
                  </Button>
                </InlineStack>
                {errors.shopifyVariantId ? (
                  <InlineError
                    message={errors.shopifyVariantId}
                    fieldID="shopifyVariantId"
                  />
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <FormLayout>
                <TextField
                  label="Service name"
                  value={form.title}
                  onChange={set("title")}
                  error={errors.title}
                  autoComplete="off"
                />
                <Checkbox
                  label="Accept bookings"
                  helpText="Turn off to hide this service from the storefront without losing its settings or bookings."
                  checked={form.active}
                  onChange={set("active")}
                />
              </FormLayout>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Appointment length and spacing
                </Text>
                <FormLayout>
                  <FormLayout.Group>
                    <NumberField
                      label="Duration"
                      suffix="minutes"
                      value={form.durationMinutes}
                      onChange={set("durationMinutes")}
                      error={errors.durationMinutes}
                    />
                    <NumberField
                      label="Start a slot every"
                      suffix="minutes"
                      value={form.slotIntervalMinutes ?? ""}
                      onChange={set("slotIntervalMinutes")}
                      error={errors.slotIntervalMinutes}
                      placeholder={duration ? String(duration) : undefined}
                      helpText="Leave empty to use the duration."
                    />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <NumberField
                      label="Buffer before"
                      suffix="minutes"
                      value={form.bufferBeforeMinutes}
                      onChange={set("bufferBeforeMinutes")}
                      error={errors.bufferBeforeMinutes}
                    />
                    <NumberField
                      label="Buffer after"
                      suffix="minutes"
                      value={form.bufferAfterMinutes}
                      onChange={set("bufferAfterMinutes")}
                      error={errors.bufferAfterMinutes}
                      helpText="Setup or clean-up time kept free around each appointment."
                    />
                  </FormLayout.Group>
                </FormLayout>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Slot limits
                </Text>
                <Text as="p" tone="subdued">
                  How many can book the same time. You can set a different
                  limit for some weekly hours or for specific dates below.
                </Text>
                <FormLayout>
                  <FormLayout.Group>
                    <Select
                      label="Limit each slot by"
                      options={[
                        { label: "Number of people", value: "PEOPLE" },
                        { label: "Number of bookings", value: "BOOKINGS" },
                      ]}
                      value={form.capacityMode}
                      onChange={(v) => set("capacityMode")(v as CapacityModeInput)}
                      helpText={
                        byBookings
                          ? "A group booking counts once, however many people it's for."
                          : "A booking for 3 people uses 3 places."
                      }
                    />
                    <NumberField
                      label={byBookings ? "Bookings per slot" : "People per slot"}
                      value={form.capacityPerSlot}
                      onChange={set("capacityPerSlot")}
                      error={errors.capacityPerSlot}
                      helpText="More than 1 for classes or group sessions."
                    />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <NumberField
                      label="Minimum people per booking"
                      value={form.minSeatsPerBooking}
                      onChange={set("minSeatsPerBooking")}
                      error={errors.minSeatsPerBooking}
                    />
                    <NumberField
                      label="Maximum people per booking"
                      value={form.maxSeatsPerBooking ?? ""}
                      onChange={set("maxSeatsPerBooking")}
                      error={errors.maxSeatsPerBooking}
                      placeholder={byBookings ? String(form.minSeatsPerBooking || 1) : "No limit"}
                      helpText={
                        byBookings
                          ? "Leave empty to allow only the minimum."
                          : "Leave empty to allow up to the places left in the slot."
                      }
                    />
                  </FormLayout.Group>
                </FormLayout>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Weekly hours
                </Text>
                <Text as="p" tone="subdued">
                  Appointments must fit inside these hours. Buffers may extend
                  past them. Set a limit on a row to change how many can book
                  in those hours; leave it empty to use the slot limit.
                </Text>
                {DAY_NAMES.map((dayName, dayOfWeek) => {
                  const rows = form.windows
                    .map((w, index) => ({ w, index }))
                    .filter(({ w }) => w.dayOfWeek === dayOfWeek);
                  return (
                    <InlineGrid key={dayName} columns={{ xs: 1, sm: ["oneThird", "twoThirds"] }} gap="200">
                      <Text as="span" fontWeight="semibold">
                        {dayName}
                      </Text>
                      <BlockStack gap="200">
                        {rows.length === 0 ? (
                          <Text as="span" tone="subdued">
                            Closed
                          </Text>
                        ) : null}
                        {rows.map(({ w, index }) => (
                          <BlockStack key={index} gap="100">
                            <InlineStack gap="200" blockAlign="center" wrap={false}>
                              <TextField
                                label={`${dayName} opens`}
                                labelHidden
                                type="time"
                                value={w.start}
                                onChange={(start) => updateWindow(index, { start })}
                                autoComplete="off"
                              />
                              <Text as="span">to</Text>
                              <TextField
                                label={`${dayName} closes`}
                                labelHidden
                                type="time"
                                value={w.end}
                                onChange={(end) => updateWindow(index, { end })}
                                autoComplete="off"
                              />
                              <div style={{ width: 110 }}>
                                <TextField
                                  label={`${dayName} slot limit`}
                                  labelHidden
                                  type="number"
                                  min={1}
                                  prefix="Limit"
                                  value={String(w.capacity ?? "")}
                                  onChange={(capacity) => updateWindow(index, { capacity })}
                                  placeholder={String(form.capacityPerSlot)}
                                  autoComplete="off"
                                />
                              </div>
                              <Button
                                icon={DeleteIcon}
                                variant="tertiary"
                                accessibilityLabel={`Remove ${dayName} hours`}
                                onClick={() => removeWindow(index)}
                              />
                            </InlineStack>
                            {errors[`windows.${index}`] ? (
                              <InlineError
                                message={errors[`windows.${index}`]}
                                fieldID={`windows.${index}`}
                              />
                            ) : null}
                          </BlockStack>
                        ))}
                        <div>
                          <Button variant="plain" onClick={() => addWindow(dayOfWeek)}>
                            {rows.length === 0 ? "Add hours" : "Add another time range"}
                          </Button>
                        </div>
                      </BlockStack>
                    </InlineGrid>
                  );
                })}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Date-specific limits
                </Text>
                <Text as="p" tone="subdued">
                  A different limit on particular dates, for the whole day or
                  between two times. These replace the weekly limits on that
                  date.
                </Text>
                {form.capacityOverrides.map((o, index) => (
                  <BlockStack key={index} gap="100">
                    <InlineStack gap="200" blockAlign="end" wrap>
                      <TextField
                        label="Date"
                        type="date"
                        value={o.date}
                        onChange={(date) => updateOverride(index, { date })}
                        autoComplete="off"
                      />
                      <TextField
                        label="From"
                        type="time"
                        value={o.start}
                        onChange={(start) => updateOverride(index, { start })}
                        autoComplete="off"
                      />
                      <TextField
                        label="To"
                        type="time"
                        value={o.end}
                        onChange={(end) => updateOverride(index, { end })}
                        autoComplete="off"
                      />
                      <div style={{ width: 110 }}>
                        <TextField
                          label="Limit"
                          type="number"
                          min={1}
                          value={String(o.capacity)}
                          onChange={(capacity) => updateOverride(index, { capacity })}
                          autoComplete="off"
                        />
                      </div>
                      <Button
                        icon={DeleteIcon}
                        variant="tertiary"
                        accessibilityLabel="Remove date limit"
                        onClick={() => removeOverride(index)}
                      />
                    </InlineStack>
                    {errors[`capacityOverrides.${index}`] ? (
                      <InlineError
                        message={errors[`capacityOverrides.${index}`]}
                        fieldID={`capacityOverrides.${index}`}
                      />
                    ) : null}
                  </BlockStack>
                ))}
                {errors.capacityOverrides ? (
                  <InlineError message={errors.capacityOverrides} fieldID="capacityOverrides" />
                ) : null}
                {form.capacityOverrides.length < MAX_OVERRIDES ? (
                  <div>
                    <Button onClick={addOverride}>Add date limit</Button>
                  </div>
                ) : null}
                <Text as="p" tone="subdued" variant="bodySm">
                  Leave From and To empty to cover the whole day.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Booking details
                </Text>
                <Text as="p" tone="subdued">
                  After picking a time, customers answer these before adding the
                  booking to their cart. Answers appear on the order.
                </Text>
                {form.intakeQuestions.map((q, index) => (
                  <BlockStack key={q.id} gap="200">
                    <InlineStack gap="200" blockAlign="end" wrap={false}>
                      <div style={{ minWidth: 130 }}>
                        <Select
                          label="Type"
                          options={[
                            { label: "Text answer", value: "text" },
                            { label: "Checkbox", value: "checkbox" },
                          ]}
                          value={q.type}
                          onChange={(type) =>
                            updateQuestion(index, { type: type as IntakeQuestion["type"] })
                          }
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <TextField
                          label={q.type === "checkbox" ? "Checkbox label" : "Question"}
                          value={q.label}
                          onChange={(label) => updateQuestion(index, { label })}
                          placeholder={
                            q.type === "checkbox"
                              ? "Do you accept the terms and conditions?"
                              : "What are your goals for this visit?"
                          }
                          autoComplete="off"
                        />
                      </div>
                      <Button
                        icon={DeleteIcon}
                        variant="tertiary"
                        accessibilityLabel="Remove question"
                        onClick={() => removeQuestion(index)}
                      />
                    </InlineStack>
                    <TextField
                      label="Help text"
                      value={q.help ?? ""}
                      onChange={(help) => updateQuestion(index, { help })}
                      placeholder="Optional, shown under the question"
                      autoComplete="off"
                    />
                    <Checkbox
                      label={q.type === "checkbox" ? "Must be ticked" : "Required"}
                      checked={q.required}
                      onChange={(required) => updateQuestion(index, { required })}
                    />
                    {errors[`intakeQuestions.${index}`] ? (
                      <InlineError
                        message={errors[`intakeQuestions.${index}`]}
                        fieldID={`intakeQuestions.${index}`}
                      />
                    ) : null}
                  </BlockStack>
                ))}
                {errors.intakeQuestions ? (
                  <InlineError message={errors.intakeQuestions} fieldID="intakeQuestions" />
                ) : null}
                <div>
                  <Button onClick={addQuestion}>Add question</Button>
                </div>
                <Checkbox
                  label="Require a signature"
                  helpText="Customers draw their signature to confirm your terms."
                  checked={form.requireSignature}
                  onChange={set("requireSignature")}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Add-on products
                </Text>
                <Text as="p" tone="subdued">
                  Offered as “Add these to your order” in the booking popup. Up
                  to {MAX_UPSELLS}.
                </Text>
                {form.upsellVariantIds.map((id) => (
                  <InlineStack key={id} gap="200" blockAlign="center" align="space-between">
                    <Text as="span">{upsellLabels[id] ?? "Selected variant"}</Text>
                    <Button
                      icon={DeleteIcon}
                      variant="tertiary"
                      accessibilityLabel="Remove add-on"
                      onClick={() => removeUpsell(id)}
                    />
                  </InlineStack>
                ))}
                {errors.upsellVariantIds ? (
                  <InlineError message={errors.upsellVariantIds} fieldID="upsellVariantIds" />
                ) : null}
                <div>
                  <Button onClick={pickUpsells}>
                    {form.upsellVariantIds.length ? "Change products" : "Choose products"}
                  </Button>
                </div>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Booking rules
                </Text>
                <NumberField
                  label="Minimum notice"
                  suffix="minutes"
                  value={form.leadTimeMinutes}
                  onChange={set("leadTimeMinutes")}
                  error={errors.leadTimeMinutes}
                  helpText="How soon before an appointment customers can still book it."
                />
                <NumberField
                  label="Book up to"
                  suffix="days ahead"
                  value={form.maxAdvanceDays}
                  onChange={set("maxAdvanceDays")}
                  error={errors.maxAdvanceDays}
                />
              </BlockStack>
            </Card>
            <Card>
              <Select
                label="Timezone"
                options={timezoneOptions}
                value={form.timezone ?? ""}
                onChange={set("timezone")}
                error={errors.timezone}
                helpText="Opening hours are read in this timezone."
              />
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function NumberField(props: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  error?: string;
  suffix?: string;
  helpText?: string;
  placeholder?: string;
}) {
  return (
    <TextField
      label={props.label}
      type="number"
      min={0}
      value={String(props.value)}
      onChange={props.onChange}
      error={props.error}
      suffix={props.suffix}
      helpText={props.helpText}
      placeholder={props.placeholder}
      autoComplete="off"
    />
  );
}
