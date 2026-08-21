// Handler for deleting QuickBooks entities

import QuickBooks from "node-quickbooks";
import { promisify, promisifyWrite } from "../../client/index.js";
import { formatDollars, toCents } from "../../utils/index.js";

type EntityType = "journal_entry" | "bill" | "invoice" | "deposit" | "sales_receipt" | "expense" | "vendor_credit" | "bill_payment" | "attachable";

interface EntityConfig {
  getMethod: string;
  deleteMethod: string;
  label: string;
  formatSummary: (entity: Record<string, unknown>) => string;
}

const ENTITY_CONFIG: Record<EntityType, EntityConfig> = {
  journal_entry: {
    getMethod: "getJournalEntry",
    deleteMethod: "deleteJournalEntry",
    label: "Journal Entry",
    formatSummary: (e) => {
      const lines = [`Journal Entry #${e.Id}`];
      lines.push(`  Date: ${e.TxnDate}`);
      if (e.DocNumber) lines.push(`  Journal no.: ${e.DocNumber}`);
      if (e.TotalAmt != null) lines.push(`  Total: $${formatDollars(toCents(e.TotalAmt as number))}`);
      if (e.PrivateNote) lines.push(`  Memo: ${e.PrivateNote}`);
      return lines.join("\n");
    },
  },
  bill: {
    getMethod: "getBill",
    deleteMethod: "deleteBill",
    label: "Bill",
    formatSummary: (e) => {
      const vendor = (e.VendorRef as Record<string, string>)?.name || "(no vendor)";
      const lines = [`Bill #${e.Id} — ${vendor}`];
      lines.push(`  Date: ${e.TxnDate}`);
      if (e.DueDate) lines.push(`  Due: ${e.DueDate}`);
      if (e.DocNumber) lines.push(`  Ref no.: ${e.DocNumber}`);
      if (e.TotalAmt != null) lines.push(`  Total: $${formatDollars(toCents(e.TotalAmt as number))}`);
      if (e.PrivateNote) lines.push(`  Memo: ${e.PrivateNote}`);
      return lines.join("\n");
    },
  },
  invoice: {
    getMethod: "getInvoice",
    deleteMethod: "deleteInvoice",
    label: "Invoice",
    formatSummary: (e) => {
      const customer = (e.CustomerRef as Record<string, string>)?.name || "(no customer)";
      const lines = [`Invoice #${e.Id} — ${customer}`];
      lines.push(`  Date: ${e.TxnDate}`);
      if (e.DueDate) lines.push(`  Due: ${e.DueDate}`);
      if (e.DocNumber) lines.push(`  Ref no.: ${e.DocNumber}`);
      if (e.TotalAmt != null) lines.push(`  Total: $${formatDollars(toCents(e.TotalAmt as number))}`);
      if (e.Balance != null) lines.push(`  Balance: $${formatDollars(toCents(e.Balance as number))}`);
      if (e.PrivateNote) lines.push(`  Memo: ${e.PrivateNote}`);
      return lines.join("\n");
    },
  },
  deposit: {
    getMethod: "getDeposit",
    deleteMethod: "deleteDeposit",
    label: "Deposit",
    formatSummary: (e) => {
      const acct = (e.DepositToAccountRef as Record<string, string>)?.name || "(unknown account)";
      const lines = [`Deposit #${e.Id} — to ${acct}`];
      lines.push(`  Date: ${e.TxnDate}`);
      if (e.TotalAmt != null) lines.push(`  Total: $${formatDollars(toCents(e.TotalAmt as number))}`);
      if (e.PrivateNote) lines.push(`  Memo: ${e.PrivateNote}`);
      return lines.join("\n");
    },
  },
  sales_receipt: {
    getMethod: "getSalesReceipt",
    deleteMethod: "deleteSalesReceipt",
    label: "Sales Receipt",
    formatSummary: (e) => {
      const customer = (e.CustomerRef as Record<string, string>)?.name || "(no customer)";
      const lines = [`Sales Receipt #${e.Id} — ${customer}`];
      lines.push(`  Date: ${e.TxnDate}`);
      if (e.DocNumber) lines.push(`  Ref no.: ${e.DocNumber}`);
      if (e.TotalAmt != null) lines.push(`  Total: $${formatDollars(toCents(e.TotalAmt as number))}`);
      if (e.PrivateNote) lines.push(`  Memo: ${e.PrivateNote}`);
      return lines.join("\n");
    },
  },
  expense: {
    getMethod: "getPurchase",
    deleteMethod: "deletePurchase",
    label: "Expense",
    formatSummary: (e) => {
      const payee = (e.EntityRef as Record<string, string>)?.name || "(no payee)";
      const lines = [`Expense #${e.Id} — ${payee}`];
      lines.push(`  Date: ${e.TxnDate}`);
      if (e.PaymentType) lines.push(`  Payment type: ${e.PaymentType}`);
      if (e.DocNumber) lines.push(`  Ref no.: ${e.DocNumber}`);
      if (e.TotalAmt != null) lines.push(`  Total: $${formatDollars(toCents(e.TotalAmt as number))}`);
      if (e.PrivateNote) lines.push(`  Memo: ${e.PrivateNote}`);
      return lines.join("\n");
    },
  },
  bill_payment: {
    getMethod: "getBillPayment",
    deleteMethod: "deleteBillPayment",
    label: "Bill Payment",
    formatSummary: (e) => {
      const vendor = (e.VendorRef as Record<string, string>)?.name || "(no vendor)";
      const lines = [`Bill Payment #${e.Id} — ${vendor}`];
      lines.push(`  Date: ${e.TxnDate}`);
      if (e.PayType) lines.push(`  Pay type: ${e.PayType}`);
      if (e.DocNumber) lines.push(`  Ref no.: ${e.DocNumber}`);
      if (e.TotalAmt != null) lines.push(`  Total: $${formatDollars(toCents(e.TotalAmt as number))}`);
      if (e.PrivateNote) lines.push(`  Memo: ${e.PrivateNote}`);
      return lines.join("\n");
    },
  },
  vendor_credit: {
    getMethod: "getVendorCredit",
    deleteMethod: "deleteVendorCredit",
    label: "Vendor Credit",
    formatSummary: (e) => {
      const vendor = (e.VendorRef as Record<string, string>)?.name || "(no vendor)";
      const lines = [`Vendor Credit #${e.Id} — ${vendor}`];
      lines.push(`  Date: ${e.TxnDate}`);
      if (e.DocNumber) lines.push(`  Ref no.: ${e.DocNumber}`);
      if (e.TotalAmt != null) lines.push(`  Total: $${formatDollars(toCents(e.TotalAmt as number))}`);
      if (e.PrivateNote) lines.push(`  Memo: ${e.PrivateNote}`);
      return lines.join("\n");
    },
  },
  attachable: {
    getMethod: "getAttachable",
    deleteMethod: "deleteAttachable",
    label: "Attachment",
    formatSummary: (e) => {
      const linkedEntity = (e.AttachableRef as Array<{ EntityRef?: { type?: string; value?: string } }>)?.[0]?.EntityRef;
      const linked = linkedEntity?.type && linkedEntity?.value ? `linked to ${linkedEntity.type} #${linkedEntity.value}` : "(not linked to any entity)";
      return `Attachment "${e.FileName}" — ${linked}`;
    },
  },
};

const VALID_TYPES = Object.keys(ENTITY_CONFIG).join(", ");

/**
 * The body QBO wants for `?operation=delete`: the Id and the SyncToken, nothing
 * else.
 *
 * This has to be built by hand because node-quickbooks' `delete` branches on its
 * argument. Given an object it posts that object as-is; given a bare id string
 * it re-reads the entity and posts the *whole* entity back. The echoed body is
 * what breaks the delete: a read includes read-only JAXB extension blocks (a
 * Purchase carries `PurchaseEx`, whose entries name `javax.xml.bind` scopes) that
 * QBO emits but refuses to accept as input, so the round trip fails validation
 * with an HTTP 400. Sending the minimal object avoids the echo entirely, and
 * does so for every entity type — the extension blocks differ per entity but the
 * hazard does not.
 */
function buildDeleteBody(entity: Record<string, unknown> | undefined, id: string, label: string): { Id: string; SyncToken: string } {
  const entityId = entity?.Id != null ? String(entity.Id).trim() : "";
  if (!entityId) {
    throw new Error(`Could not load ${label} #${id} to delete — QuickBooks returned no Id for it.`);
  }

  // A SyncToken is mandatory on delete. QBO always returns one on a read, but if
  // it ever comes back blank, "0" (the value a newly created entity carries) is
  // the safe guess: a stale token is rejected outright with a fault, so a wrong
  // guess fails loudly rather than deleting anything unexpected.
  const rawToken = entity?.SyncToken;
  const syncToken = rawToken != null && String(rawToken).trim() !== "" ? String(rawToken).trim() : "0";

  return { Id: entityId, SyncToken: syncToken };
}

export async function handleDeleteEntity(
  client: QuickBooks,
  args: { entity_type: string; id: string; confirm?: boolean }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { entity_type, id, confirm = false } = args;

  const config = ENTITY_CONFIG[entity_type as EntityType];
  if (!config) {
    throw new Error(`Invalid entity_type "${entity_type}". Must be one of: ${VALID_TYPES}`);
  }

  // Both paths need the entity: the preview to describe it, the delete to read
  // its SyncToken. One read serves whichever path runs.
  const entity = await promisify<Record<string, unknown>>((cb) =>
    (client as any)[config.getMethod](id, cb)
  );

  if (!confirm) {
    const summary = config.formatSummary(entity);
    return {
      content: [{
        type: "text",
        text: `${summary}\n\nThis will permanently delete this ${config.label.toLowerCase()}. Call again with confirm=true to delete.`,
      }],
    };
  }

  // Execute delete against the minimal body, so node-quickbooks forwards it
  // untouched instead of re-reading and echoing the full entity.
  await promisifyWrite<unknown>((cb) =>
    (client as any)[config.deleteMethod](buildDeleteBody(entity, id, config.label), cb)
  );

  return {
    content: [{
      type: "text",
      text: `Deleted ${config.label} #${id}.`,
    }],
  };
}
