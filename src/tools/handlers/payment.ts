// Handler for receive_payment — the A/R counterpart to create_bill_payment.
//
// A Payment is the QBO entity behind "Receive Payment": it settles one or more
// Invoices, clearing Accounts Receivable. It is not a Deposit — a Deposit books
// money into a bank account without touching an invoice, and a SalesReceipt
// records a sale that was paid at the point of sale and so never had an invoice
// to settle.
//
// Note that a Payment carries no ARAccountRef in the payload (confirmed against
// a live company), which is why query_account_transactions cannot see its A/R
// side. That limits the read path, not this one: applying a payment needs the
// invoice id and its balance, both of which read fine.

import QuickBooks from "node-quickbooks";
import {
  promisify,
  promisifyWrite,
  getAccountCache,
  resolveAccountRef,
  resolveCustomer,
  toQboRef,
} from "../../client/index.js";
import {
  buildQboUrl,
  validateAmount,
  toCents,
  toDollars,
  formatDollars,
  sumCents,
} from "../../utils/index.js";

interface PaymentInvoiceInput {
  invoice_id: string;
  amount?: number;
}

interface FetchedInvoice {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  Balance?: number;
  CustomerRef?: { value: string; name?: string };
}

interface PaymentMethodRow {
  Id: string;
  Name: string;
}

/**
 * Where the money lands.
 *
 * Bank-type is the restriction #24 established for tools that move money: an
 * unrestricted partial match can land on an account that merely shares digits or
 * words with the intended one. Undeposited Funds is the documented exception,
 * and not a cosmetic one — it is what QBO itself defaults a Payment to when the
 * field is omitted, so refusing it would refuse the product's own default.
 */
async function resolveDepositAccount(client: QuickBooks, account: string) {
  const cache = await getAccountCache(client);
  try {
    return resolveAccountRef(cache, account, { label: "Deposit account", accountType: "Bank" });
  } catch (bankMiss) {
    const loose = (() => {
      try {
        return resolveAccountRef(cache, account, { label: "Deposit account" });
      } catch {
        return undefined;
      }
    })();
    if (loose && cache.byId.get(loose.value)?.AccountSubType === "UndepositedFunds") {
      return loose;
    }
    throw bankMiss;
  }
}

async function resolvePaymentMethod(
  client: QuickBooks,
  nameOrId: string
): Promise<{ value: string; name: string }> {
  // There are a handful of these on any company, so fetch the list and match
  // here rather than building a filter — it also lets an id and a name resolve
  // through the same call.
  const result = await promisify<unknown>((cb) => client.findPaymentMethods(cb));
  const methods =
    (result as { QueryResponse?: { PaymentMethod?: PaymentMethodRow[] } })?.QueryResponse
      ?.PaymentMethod ?? [];

  const wanted = nameOrId.trim().toLowerCase();
  const match =
    methods.find(m => m.Id === nameOrId.trim()) ??
    methods.find(m => m.Name?.toLowerCase() === wanted);
  if (match) return { value: match.Id, name: match.Name };

  const known = methods.map(m => m.Name).filter(Boolean).join(", ");
  throw new Error(
    `Payment method not found: "${nameOrId}"${known ? `. Available: ${known}` : ""}`
  );
}

export async function handleReceivePayment(
  client: QuickBooks,
  args: {
    customer_name?: string;
    customer_id?: string;
    invoices: PaymentInvoiceInput[];
    txn_date: string;
    deposit_to_account?: string;
    amount?: number;
    payment_method?: string;
    reference_no?: string;
    memo?: string;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    customer_name, customer_id, invoices, txn_date, deposit_to_account,
    amount, payment_method, reference_no, memo, draft = true,
  } = args;

  if (!invoices || invoices.length === 0) {
    throw new Error("At least one invoice is required");
  }

  const customer = await resolveCustomer(client, customer_id || customer_name || "");
  if (!customer_id && !customer_name) {
    throw new Error("Either customer_name or customer_id is required");
  }

  const depositRef = deposit_to_account
    ? await resolveDepositAccount(client, deposit_to_account)
    : undefined;

  const methodRef = payment_method
    ? await resolvePaymentMethod(client, payment_method)
    : undefined;

  // Fetch each invoice: proves it exists, proves it belongs to this customer,
  // and supplies the open balance as the amount to apply. QBO does reject a
  // cross-customer application, but only with "TxnID Cannot Be Linked", which
  // says nothing about which invoice or whose it is.
  const fetched = await Promise.all(
    invoices.map(async (entry) => {
      const invoice = (await promisify<unknown>((cb) =>
        client.getInvoice(entry.invoice_id, cb)
      )) as FetchedInvoice;

      if (invoice.CustomerRef?.value !== customer.value) {
        throw new Error(
          `Invoice ${entry.invoice_id} (#${invoice.DocNumber || "?"}) belongs to customer ` +
            `"${invoice.CustomerRef?.name || invoice.CustomerRef?.value}", not "${customer.name}"`
        );
      }

      // API-sourced value: round to cents (validateAmount is for user input).
      const openCents = toCents(invoice.Balance ?? 0);
      let applyCents: number;
      if (entry.amount !== undefined) {
        applyCents = validateAmount(entry.amount, `Invoice ${entry.invoice_id} amount`);
        if (applyCents <= 0) {
          throw new Error(`Invoice ${entry.invoice_id}: amount must be positive`);
        }
        if (applyCents > openCents) {
          throw new Error(
            `Invoice ${entry.invoice_id} (#${invoice.DocNumber || "?"}): amount ` +
              `$${formatDollars(applyCents)} exceeds open balance $${formatDollars(openCents)}`
          );
        }
      } else {
        if (openCents === 0) {
          throw new Error(
            `Invoice ${entry.invoice_id} (#${invoice.DocNumber || "?"}) has no open balance — already paid?`
          );
        }
        applyCents = openCents;
      }

      return {
        id: invoice.Id,
        doc: invoice.DocNumber,
        date: invoice.TxnDate,
        openCents,
        applyCents,
      };
    })
  );

  const appliedCents = sumCents(fetched.map(f => f.applyCents));

  // A payment larger than what it settles is legal — QBO parks the remainder as
  // an unapplied credit on the customer. Confirmed against a live company: a $15
  // payment against a $10 invoice comes back with UnappliedAmt 5. It is worth
  // stating rather than discovering later, so the preview names it.
  let totalCents = appliedCents;
  if (amount !== undefined) {
    totalCents = validateAmount(amount, "Payment amount");
    if (totalCents < appliedCents) {
      throw new Error(
        `Payment amount $${formatDollars(totalCents)} is less than the ` +
          `$${formatDollars(appliedCents)} being applied to invoices`
      );
    }
  }
  const unappliedCents = totalCents - appliedCents;

  const paymentObject: Record<string, unknown> = {
    CustomerRef: { value: customer.value, name: customer.name },
    TxnDate: txn_date,
    TotalAmt: toDollars(totalCents),
    ...(depositRef && { DepositToAccountRef: toQboRef(depositRef) }),
    ...(methodRef && { PaymentMethodRef: methodRef }),
    ...(reference_no && { PaymentRefNum: reference_no }),
    ...(memo && { PrivateNote: memo }),
    Line: fetched.map(f => ({
      Amount: toDollars(f.applyCents),
      LinkedTxn: [{ TxnId: f.id, TxnType: "Invoice" }],
    })),
  };

  const depositLabel = depositRef
    ? depositRef.name
    : "(QuickBooks default — normally Undeposited Funds)";

  if (draft) {
    const preview = [
      "DRAFT - Receive Payment Preview",
      "",
      `Customer: ${customer.name}`,
      `Deposit to: ${depositLabel}`,
      `Date: ${txn_date}`,
      `Payment method: ${methodRef?.name || "(none)"}`,
      `Reference no.: ${reference_no || "(none)"}`,
      `Memo: ${memo || "(none)"}`,
      "",
      "Invoices settled:",
      ...fetched.map(f =>
        `  Invoice ${f.id} (#${f.doc || "?"}, ${f.date || "?"}): ` +
          `open $${formatDollars(f.openCents)} → applying $${formatDollars(f.applyCents)} ` +
          `→ remaining $${formatDollars(f.openCents - f.applyCents)}`
      ),
      "",
      `Applied to invoices: $${formatDollars(appliedCents)}`,
      ...(unappliedCents > 0
        ? [
            `Payment total: $${formatDollars(totalCents)}`,
            `UNAPPLIED: $${formatDollars(unappliedCents)} will sit as an ` +
              `unapplied credit on ${customer.name}, not against any invoice.`,
          ]
        : [`Payment total: $${formatDollars(totalCents)}`]),
      "",
      "Set draft=false to record this payment.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  const result = (await promisifyWrite<unknown>((cb) =>
    client.createPayment(paymentObject, cb)
  )) as { Id: string; UnappliedAmt?: number };

  const response = [
    "Payment Received!",
    "",
    `Customer: ${customer.name}`,
    `Deposit to: ${depositLabel}`,
    `Date: ${txn_date}`,
    `Invoices settled: ${fetched.map(f => `#${f.doc || f.id}`).join(", ")}`,
    `Payment total: $${formatDollars(totalCents)}`,
    ...(result.UnappliedAmt
      ? [`Unapplied credit: $${formatDollars(toCents(result.UnappliedAmt))}`]
      : []),
    "",
    `Payment ID: ${result.Id}`,
    `View in QuickBooks: ${buildQboUrl("payment", "txnId", result.Id)}`,
  ].join("\n");

  return { content: [{ type: "text", text: response }] };
}
