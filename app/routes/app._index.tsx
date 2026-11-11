import { useEffect, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import {
  Badge,
  Banner,
  Box,
  Button,
  ButtonGroup,
  Card,
  EmptyState,
  IndexTable,
  Layout,
  Link,
  Modal,
  Page,
  Text,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getOrCreateShop } from "../lib/shop.server";
import { DAY_NAMES } from "../lib/services/validation";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  // First admin page a merchant sees, so this is where the Shop row and its
  // timezone get created and kept fresh.
  const shop = await getOrCreateShop(session.shop, admin);

  const services = await db.service.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      title: true,
      active: true,
      durationMinutes: true,
      capacityPerSlot: true,
      availabilityRules: { select: { dayOfWeek: true } },
    },
  });

  return {
    timezone: shop.timezone,
    services: services.map(({ availabilityRules, ...s }) => ({
      ...s,
      days: summariseDays(availabilityRules.map((r) => r.dayOfWeek)),
    })),
  };
};

/** [1,2,3,4,5] => "Mon–Fri"; [1,3] => "Mon, Wed"; [] => "No hours set". */
function summariseDays(days: number[]): string {
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length === 0) return "No hours set";
  if (unique.length === 7) return "Every day";
  const short = (d: number) => DAY_NAMES[d].slice(0, 3);
  const contiguous = unique.every((d, i) => i === 0 || d === unique[i - 1] + 1);
  if (contiguous && unique.length > 2) {
    return `${short(unique[0])}–${short(unique[unique.length - 1])}`;
  }
  return unique.map(short).join(", ");
}

export default function Services() {
  const { services, timezone } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  // Delete goes through the editor route's action (intent "delete"), which
  // scopes to the shop, refuses services with bookings and clears the
  // variant's storefront flags. It redirects back here on success.
  const deleter = useFetcher<{ ok: false; errors: Record<string, string> }>();
  const [confirming, setConfirming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteError =
    deleter.state === "idle" && deleter.data && !deleter.data.ok
      ? deleter.data.errors.form ?? "This service couldn't be deleted."
      : null;

  useEffect(() => {
    if (!deleting || deleter.state !== "idle") return;
    setDeleting(false);
    setConfirming(null);
    if (!deleter.data) shopify.toast.show("Service deleted");
  }, [deleting, deleter.state, deleter.data, shopify]);

  const confirmDelete = () => {
    if (!confirming) return;
    setDeleting(true);
    deleter.submit(
      { intent: "delete" },
      { method: "POST", action: `/app/services/${confirming.id}` },
    );
  };

  const newService = { content: "New service", url: "/app/services/new" };

  return (
    <Page
      title="Services"
      subtitle={`Times shown in ${timezone}`}
      primaryAction={services.length > 0 ? newService : undefined}
    >
      <Layout>
        {deleteError ? (
          <Layout.Section>
            <Banner tone="critical" title="Service not deleted">
              <p>{deleteError}</p>
            </Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <Card padding="0">
            {services.length === 0 ? (
              <EmptyState
                heading="Create your first bookable service"
                action={newService}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Link a product, set how long an appointment takes and when
                  you're open. Customers then pick a time on the product page.
                </p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "service", plural: "services" }}
                itemCount={services.length}
                selectable={false}
                headings={[
                  { title: "Service" },
                  { title: "Duration" },
                  { title: "Open" },
                  { title: "Per slot" },
                  { title: "Status" },
                  { title: "Actions", alignment: "end" },
                ]}
              >
                {services.map((s, index) => (
                  <IndexTable.Row
                    id={s.id}
                    key={s.id}
                    position={index}
                    onClick={() => navigate(`/app/services/${s.id}`)}
                  >
                    <IndexTable.Cell>
                      {/* Long product names are truncated so the other columns stay visible. */}
                      <Box maxWidth="28rem">
                        <Link url={`/app/services/${s.id}`} monochrome removeUnderline>
                          <Text as="span" fontWeight="semibold" truncate>
                            {s.title}
                          </Text>
                        </Link>
                      </Box>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{s.durationMinutes} min</IndexTable.Cell>
                    <IndexTable.Cell>{s.days}</IndexTable.Cell>
                    <IndexTable.Cell>{s.capacityPerSlot}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {s.active ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge>Paused</Badge>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {/* Keep these clicks from also triggering the row's onClick. */}
                      <div
                        style={{ display: "flex", justifyContent: "flex-end" }}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        role="presentation"
                      >
                        <ButtonGroup>
                          <Button url={`/app/services/${s.id}`}>Edit</Button>
                          <Button
                            tone="critical"
                            onClick={() => setConfirming({ id: s.id, title: s.title })}
                          >
                            Delete
                          </Button>
                        </ButtonGroup>
                      </div>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={confirming !== null}
        onClose={() => {
          if (!deleting) setConfirming(null);
        }}
        title="Delete service?"
        primaryAction={{
          content: "Delete",
          destructive: true,
          loading: deleting,
          onAction: confirmDelete,
        }}
        secondaryActions={[
          { content: "Cancel", disabled: deleting, onAction: () => setConfirming(null) },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            Delete <Text as="span" fontWeight="semibold">{confirming?.title}</Text>?
            Customers will no longer be able to book it. This can't be undone.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
