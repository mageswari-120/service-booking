import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

import styles from "./styles.module.css";

/**
 * Public landing page at the app URL.
 *
 * Shopify opens the app with `?shop=…`, which goes straight into the embedded
 * app (OAuth runs there if needed). There is deliberately no shop-domain form:
 * App Store requirement 2.3.1 forbids asking merchants to type their
 * myshopify.com domain — installs must start from a Shopify surface.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Service Booking</h1>
        <p className={styles.text}>
          Let customers book appointments, classes and services straight from
          your product pages, and pay through your normal Shopify checkout.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Bookable services</strong>. Set durations, opening hours,
            buffers and how many people each slot takes.
          </li>
          <li>
            <strong>Live availability</strong>. Customers only see times that
            are actually free, and their slot is held while they check out.
          </li>
          <li>
            <strong>Confirmations</strong>. Every paid order becomes a booking
            and the customer gets a confirmation email.
          </li>
        </ul>
        <p className={styles.text}>
          Install Service Booking from the Shopify App Store, then open it from
          your Shopify admin.
        </p>
      </div>
    </div>
  );
}
