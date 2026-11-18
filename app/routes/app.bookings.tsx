import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  Link,
  Page,
  Text,
} from "@shopify/polaris";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getOrCreateShop } from "../lib/shop.server";
import { lookupShopName, sendBookingConfirmation } from "../lib/bookings/confirmation.server";

const PAGE_SIZE = 50;

/**
 * Every booking taken through the storefront widget, newest appointment first.
 *
 * App Store requirement 5.1.5: customer data collected on the Online Store has
 * to be visible to the merchant in Shopify, not only in our database.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop, admin);

  const url = new URL(request.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);

  const [total, bookings] = await Promise.all([
    db.booking.count({ where: { shopId: shop.id } }),
    db.booking.findMany({
      where: { shopId: shop.id },
      orderBy: { startsAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        startsAt: true,
        seats: true,
        status: true,
        customerName: true,
        customerEmail: true,
        customerPhone: true,
        shopifyOrderId: true,
        shopifyOrderName: true,
        confirmationSentAt: true,
        service: { select: { title: true } },
      },
    }),
  ]);

  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: shop.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return {
    timezone: shop.timezone,
    page,
    hasNext: page * PAGE_SIZE < total,
    total,
    bookings: bookings.map((b) => ({
      id: b.id,
      when: when.format(b.startsAt),
      service: b.service.title,
      seats: b.seats,
      status: b.status,
      customerName: b.customerName,
      customerEmail: b.customerEmail,
      customerPhone: b.customerPhone,
      orderName: b.shopifyOrderName,
      emailSent: !!b.confirmationSentAt,
      // Stored as a GID (gid://shopify/Order/123); the admin URL wants the number.
      orderId: b.shopifyOrderId.split("/").pop() ?? null,
    })),
  };
};

type ResendResult = { ok: true } | { ok: false; error: string };

/** Manual (re)send of a booking's confirmation email from the list. */
export const action = async ({ request }: ActionFunctionArgs): Promise<ResendResult> => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") !== "resend-confirmation") return { ok: false, error: "Unknown action" };

  const bookingId = String(form.get("bookingId") ?? "");
  const shop = await getOrCreateShop(session.shop, admin);
  // Only this shop's bookings.
  const owned = await db.booking.findFirst({ where: { id: bookingId, shopId: shop.id }, select: { id: true } });
  if (!owned) return { ok: false, error: "Booking not found" };

  const shopName = await lookupShopName(session.shop, admin);
  const result = await sendBookingConfirmation(bookingId, { shopName, force: true });
  if (result.ok) return { ok: true };
  if (result.reason === "not-eligible") {
    return { ok: false, error: "Only confirmed bookings with an email can be sent" };
  }
  return { ok: false, error: result.error ?? "Email could not be sent" };
};

function ResendEmailButton({ bookingId, sent }: { bookingId: string; sent: boolean }) {
  const fetcher = useFetcher<ResendResult>();
  const shopify = useAppBridge();
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) shopify.toast.show("Confirmation email sent");
    else shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <Button
      size="micro"
      variant="plain"
      loading={fetcher.state !== "idle"}
      onClick={() => fetcher.submit({ intent: "resend-confirmation", bookingId }, { method: "post" })}
    >
      {sent ? "Resend email" : "Send email"}
    </Button>
  );
}

const STATUS_BADGE: Record<string, { label: string; tone?: "success" | "critical" | "warning" | "info" }> = {
  CONFIRMED: { label: "Confirmed", tone: "success" },
  CONFLICT: { label: "Conflict", tone: "critical" },
  CANCELLED: { label: "Cancelled" },
  COMPLETED: { label: "Completed", tone: "info" },
  NO_SHOW: { label: "No-show", tone: "warning" },
};

export default function Bookings() {
  const { bookings, timezone, page, hasNext, total } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  return (
    <Page title="Bookings" subtitle={`${total} total · times shown in ${timezone}`}>
      <Card padding="0">
        {bookings.length === 0 ? (
          <EmptyState
            heading="No bookings yet"
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>
              When a customer books a time and completes checkout, the booking
              shows up here with a link to its order.
            </p>
          </EmptyState>
        ) : (
          <IndexTable
            resourceName={{ singular: "booking", plural: "bookings" }}
            itemCount={bookings.length}
            selectable={false}
            headings={[
              { title: "Appointment" },
              { title: "Service" },
              { title: "Customer" },
              { title: "Seats" },
              { title: "Status" },
              { title: "Email" },
              { title: "Order" },
            ]}
            pagination={{
              hasPrevious: page > 1,
              hasNext,
              onPrevious: () => setSearchParams({ page: String(page - 1) }),
              onNext: () => setSearchParams({ page: String(page + 1) }),
            }}
          >
            {bookings.map((b, index) => {
              const badge = STATUS_BADGE[b.status] ?? { label: b.status };
              return (
                <IndexTable.Row id={b.id} key={b.id} position={index}>
                  <IndexTable.Cell>
                    <Text as="span" fontWeight="semibold">
                      {b.when}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{b.service}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <BlockStack gap="050">
                      <Text as="span">{b.customerName ?? "—"}</Text>
                      {b.customerEmail ? (
                        <Text as="span" tone="subdued">
                          {b.customerEmail}
                        </Text>
                      ) : null}
                      {b.customerPhone ? (
                        <Text as="span" tone="subdued">
                          {b.customerPhone}
                        </Text>
                      ) : null}
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{b.seats}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {b.status === "CONFIRMED" && b.customerEmail ? (
                      <BlockStack gap="100" inlineAlign="start">
                        <Badge tone={b.emailSent ? "success" : "warning"}>
                          {b.emailSent ? "Sent" : "Not sent"}
                        </Badge>
                        <ResendEmailButton bookingId={b.id} sent={b.emailSent} />
                      </BlockStack>
                    ) : (
                      "—"
                    )}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {b.orderId ? (
                      <Link url={`shopify://admin/orders/${b.orderId}`} target="_top">
                        {b.orderName ?? `Order ${b.orderId}`}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </IndexTable.Cell>
                </IndexTable.Row>
              );
            })}
          </IndexTable>
        )}
      </Card>
    </Page>
  );
}
