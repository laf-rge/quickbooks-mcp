// Handler for deleting QuickBooks entities

import QuickBooks from "node-quickbooks";
import { promisify } from "../../client/index.js";
import { formatDollars, toCents } from "../../utils/index.js";

type EntityType = "journal_entry" | "bill" | "invoice" | "deposit" | "sales_receipt" | "expense" | "vendor_credit" | "bill_payment";

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
};

const VALID_TYPES = Object.keys(ENTITY_CONFIG).join(", ");

export async function handleDeleteEntity(
  client: QuickBooks,
  args: { entity_type: string; id: string; confirm?: boolean }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { entity_type, id, confirm = false } = args;

  const config = ENTITY_CONFIG[entity_type as EntityType];
  if (!config) {
    throw new Error(`Invalid entity_type "${entity_type}". Must be one of: ${VALID_TYPES}`);
  }

  if (!confirm) {
    // Preview: fetch and show summary
    const entity = await promisify<Record<string, unknown>>((cb) =>
      (client as any)[config.getMethod](id, cb)
    );

    const summary = config.formatSummary(entity);
    return {
      content: [{
        type: "text",
        text: `${summary}\n\nThis will permanently delete this ${config.label.toLowerCase()}. Call again with confirm=true to delete.`,
      }],
    };
  }

  // Execute delete
  await promisify<unknown>((cb) =>
    (client as any)[config.deleteMethod]({ Id: id }, cb)
  );

  return {
    content: [{
      type: "text",
      text: `Deleted ${config.label} #${id}.`,
    }],
  };
}
