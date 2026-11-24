import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { queryActivityFeed } from "../../lib/activity";
import { resolveDemoTenant } from "../../lib/actor";
import { ActivityFeed } from "./activity-feed";

export const dynamic = "force-dynamic";

export default async function ActivityPage(): Promise<ReactNode> {
  const tenant = resolveDemoTenant(await headers());
  const initialPage = await queryActivityFeed({ tenant });

  return (
    <main style={{ padding: "1.5rem", fontFamily: "system-ui, sans-serif" }}>
      <p style={{ marginTop: 0 }}>
        <Link href="/">← Back to invoices demo</Link>
      </p>
      <h1>Activity Feed</h1>
      <p style={{ maxWidth: "56rem", color: "#52525b" }}>
        Copy-paste BFF pattern backed by <code>audit.query()</code> with keyset pagination,
        server-side actor display resolution, and allowlisted event summaries.
      </p>
      <ActivityFeed initialPage={initialPage} />
    </main>
  );
}
