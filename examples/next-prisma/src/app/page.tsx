import type { ReactNode } from "react";
import { updateInvoiceStatusForm } from "./actions";

export const dynamic = "force-dynamic";

export default function HomePage(): ReactNode {
  return (
    <main>
      <h1>Auditstream Next.js 16 + Prisma 7 Example</h1>
      <p>
        Use the Route Handlers under <code>/api/invoices</code> or submit the Server Action form
        below.
      </p>
      <form action={updateInvoiceStatusForm}>
        <label>
          Invoice ID
          <input name="id" type="number" defaultValue="1" />
        </label>
        <label>
          Status
          <input name="status" type="text" defaultValue="sent" />
        </label>
        <button type="submit">Update invoice</button>
      </form>
    </main>
  );
}
