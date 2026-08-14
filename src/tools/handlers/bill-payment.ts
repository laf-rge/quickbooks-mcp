// Handlers for bill payment tools (create, get)
//
// A BillPayment is the QBO entity behind the "check" / "pay bills" flow:
// it pays one or more Bills and can apply VendorCredits, clearing A/P.
// This is distinct from an Expense (Purchase), which books expense lines
// directly and does NOT touch existing bills.

import QuickBooks from "node-quickbooks";
import {
  promisify,
  getAccountCache,
  getVendorCache,
  resolveAccountRef,
  resolveVendorRef,
  toQboRef,
} from "../../client/index.js";
import { buildQboUrl, validateAmount, toCents, toDollars, formatDollars, sumCents, outputReport } from "../../utils/index.js";

interface BillPaymentBillInput {
  bill_id: string;
  amount?: number;
}

interface BillPaymentCreditInput {
  vendor_credit_id: string;
  amount?: number;
}

interface FetchedTxn {
  Id: string;
  DocNumber?: string;
  TxnDate?: string;
  TotalAmt?: number;
  Balance?: number;
  VendorRef?: { value: string; name?: string };
}

export async function handleCreateBillPayment(
  client: QuickBooks,
  args: {
    vendor_name?: string;
    vendor_id?: string;
    payment_account: string;
    txn_date: string;
    memo?: string;
    doc_number?: string;
    bills: BillPaymentBillInput[];
    credits?: BillPaymentCreditInput[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    vendor_name, vendor_id, payment_account, txn_date,
    memo, doc_number, bills, credits = [], draft = true,
  } = args;

  if (!bills || bills.length === 0) {
    throw new Error("At least one bill is required");
  }

  // Get cached lookups
  const [acctCache, vendorCacheData] = await Promise.all([
    getAccountCache(client),
    getVendorCache(client),
  ]);

  // Resolve vendor
  let vendorRef: { value: string; name: string };
  if (vendor_id) {
    vendorRef = resolveVendorRef(vendorCacheData, vendor_id);
  } else if (vendor_name) {
    vendorRef = resolveVendorRef(vendorCacheData, vendor_name);
  } else {
    throw new Error("Either vendor_name or vendor_id is required");
  }

  // Resolve bank account
  const bankAccountRef = toQboRef(resolveAccountRef(acctCache, payment_account));

  // Fetch each bill: validates it exists, belongs to the vendor, and supplies
  // the open balance as the default amount to apply.
  const fetchedBills = await Promise.all(
    bills.map(async (b) => {
      const bill = await promisify<unknown>((cb) => client.getBill(b.bill_id, cb)) as FetchedTxn;
      if (bill.VendorRef?.value !== vendorRef.value) {
        throw new Error(
          `Bill ${b.bill_id} (#${bill.DocNumber || "?"}) belongs to vendor "${bill.VendorRef?.name || bill.VendorRef?.value}", not "${vendorRef.name}"`
        );
      }
      // API-sourced value: round to cents (validateAmount is for user input)
      const openCents = toCents(bill.Balance ?? 0);
      let applyCents: number;
      if (b.amount !== undefined) {
        applyCents = validateAmount(b.amount, `Bill ${b.bill_id} amount`);
        if (applyCents <= 0) {
          throw new Error(`Bill ${b.bill_id}: amount must be positive`);
        }
        if (applyCents > openCents) {
          throw new Error(
            `Bill ${b.bill_id} (#${bill.DocNumber || "?"}): amount $${formatDollars(applyCents)} exceeds open balance $${formatDollars(openCents)}`
          );
        }
      } else {
        if (openCents === 0) {
          throw new Error(`Bill ${b.bill_id} (#${bill.DocNumber || "?"}) has no open balance — already paid?`);
        }
        applyCents = openCents;
      }
      return { id: bill.Id, doc: bill.DocNumber, date: bill.TxnDate, applyCents };
    })
  );

  // Fetch each vendor credit; default applied amount is its remaining balance.
  const fetchedCredits = await Promise.all(
    credits.map(async (c) => {
      const vc = await promisify<unknown>((cb) => client.getVendorCredit(c.vendor_credit_id, cb)) as FetchedTxn;
      if (vc.VendorRef?.value !== vendorRef.value) {
        throw new Error(
          `Vendor credit ${c.vendor_credit_id} (#${vc.DocNumber || "?"}) belongs to vendor "${vc.VendorRef?.name || vc.VendorRef?.value}", not "${vendorRef.name}"`
        );
      }
      // VendorCredit.Balance is the unapplied remainder; fall back to TotalAmt.
      // API-sourced value: round to cents (validateAmount is for user input).
      const availCents = toCents(vc.Balance ?? vc.TotalAmt ?? 0);
      let applyCents: number;
      if (c.amount !== undefined) {
        applyCents = validateAmount(c.amount, `Vendor credit ${c.vendor_credit_id} amount`);
        if (applyCents <= 0) {
          throw new Error(`Vendor credit ${c.vendor_credit_id}: amount must be positive`);
        }
        if (applyCents > availCents) {
          throw new Error(
            `Vendor credit ${c.vendor_credit_id} (#${vc.DocNumber || "?"}): amount $${formatDollars(applyCents)} exceeds available credit $${formatDollars(availCents)}`
          );
        }
      } else {
        if (availCents === 0) {
          throw new Error(`Vendor credit ${c.vendor_credit_id} (#${vc.DocNumber || "?"}) has no remaining balance — already applied?`);
        }
        applyCents = availCents;
      }
      return { id: vc.Id, doc: vc.DocNumber, date: vc.TxnDate, applyCents };
    })
  );

  const billCents = sumCents(fetchedBills.map(b => b.applyCents));
  const creditCents = sumCents(fetchedCredits.map(c => c.applyCents));
  const totalCents = billCents - creditCents;

  if (totalCents < 0) {
    throw new Error(
      `Applied credits ($${formatDollars(creditCents)}) exceed bill amounts ($${formatDollars(billCents)}) — payment total cannot be negative`
    );
  }

  // Build QuickBooks BillPayment object (Check pay type — covers EFT/ACH too)
  const bpObject: Record<string, unknown> = {
    VendorRef: vendorRef,
    PayType: "Check",
    CheckPayment: { BankAccountRef: bankAccountRef },
    TxnDate: txn_date,
    TotalAmt: toDollars(totalCents),
    ...(memo && { PrivateNote: memo }),
    ...(doc_number && { DocNumber: doc_number }),
    Line: [
      ...fetchedBills.map((b) => ({
        Amount: toDollars(b.applyCents),
        LinkedTxn: [{ TxnId: b.id, TxnType: "Bill" }],
      })),
      ...fetchedCredits.map((c) => ({
        Amount: toDollars(c.applyCents),
        LinkedTxn: [{ TxnId: c.id, TxnType: "VendorCredit" }],
      })),
    ],
  };

  if (draft) {
    const preview = [
      "DRAFT - Bill Payment (Check) Preview",
      "",
      `Vendor: ${vendorRef.name}`,
      `Bank Account: ${bankAccountRef.name}`,
      `Date: ${txn_date}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Memo: ${memo || "(none)"}`,
      "",
      "Bills paid:",
      ...fetchedBills.map(b =>
        `  Bill ${b.id} (#${b.doc || "?"}, ${b.date || "?"}): $${formatDollars(b.applyCents)}`
      ),
      ...(fetchedCredits.length > 0 ? [
        "",
        "Credits applied:",
        ...fetchedCredits.map(c =>
          `  Credit ${c.id} (#${c.doc || "?"}, ${c.date || "?"}): -$${formatDollars(c.applyCents)}`
        ),
      ] : []),
      "",
      `Payment total: $${formatDollars(totalCents)}`,
      "",
      "Set draft=false to create this bill payment.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the bill payment
  const result = await promisify<unknown>((cb) =>
    client.createBillPayment(bpObject, cb)
  ) as { Id: string; DocNumber?: string };

  const qboUrl = buildQboUrl("billpayment", "txnId", result.Id);

  const response = [
    "Bill Payment Created!",
    "",
    `Vendor: ${vendorRef.name}`,
    `Bank Account: ${bankAccountRef.name}`,
    `Ref no.: ${result.DocNumber || "(auto-assigned)"}`,
    `Date: ${txn_date}`,
    `Bills paid: ${fetchedBills.map(b => `#${b.doc || b.id}`).join(", ")}`,
    ...(fetchedCredits.length > 0
      ? [`Credits applied: ${fetchedCredits.map(c => `#${c.doc || c.id}`).join(", ")}`]
      : []),
    `Total: $${formatDollars(totalCents)}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return {
    content: [{ type: "text", text: response }],
  };
}

export async function handleGetBillPayment(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const bp = await promisify<unknown>((cb) =>
    client.getBillPayment(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    PayType?: string;
    VendorRef?: { value: string; name?: string };
    CheckPayment?: { BankAccountRef?: { value: string; name?: string } };
    CreditCardPayment?: { CCAccountRef?: { value: string; name?: string } };
    Line?: Array<{
      Amount: number;
      LinkedTxn?: Array<{ TxnId: string; TxnType: string }>;
    }>;
  };
  const qboUrl = buildQboUrl("billpayment", "txnId", bp.Id);

  const payAcct = bp.CheckPayment?.BankAccountRef || bp.CreditCardPayment?.CCAccountRef;

  // Net applied = bill applications minus vendor-credit applications.
  // QBO stores credit lines with positive amounts but TotalAmt is the net
  // check amount (bills − credits), so credits must be signed negative here.
  // Surfaces any unapplied remainder — a common source of bills that stay
  // open after a payment was matched.
  const appliedCents = sumCents((bp.Line || []).map(l => {
    const isCredit = l.LinkedTxn?.some(t => t.TxnType === "VendorCredit");
    return isCredit ? -toCents(l.Amount) : toCents(l.Amount);
  }));
  const totalCents = toCents(bp.TotalAmt || 0);
  const unappliedCents = totalCents - appliedCents;

  const lines: string[] = [
    'Bill Payment',
    '============',
    `ID: ${bp.Id}`,
    `SyncToken: ${bp.SyncToken}`,
    `Vendor: ${bp.VendorRef?.name || bp.VendorRef?.value || '(none)'}`,
    `Date: ${bp.TxnDate}`,
    `Ref no.: ${bp.DocNumber || '(none)'}`,
    `Pay Type: ${bp.PayType || '(unknown)'}`,
    `Account: ${payAcct?.name || payAcct?.value || '(none)'}`,
    `Memo: ${bp.PrivateNote || '(none)'}`,
    `Total: $${formatDollars(totalCents)}`,
    '',
    'Applied to:',
  ];

  for (const line of bp.Line || []) {
    for (const txn of line.LinkedTxn || []) {
      const sign = txn.TxnType === "VendorCredit" ? "-" : "";
      lines.push(`  ${txn.TxnType} ${txn.TxnId}: ${sign}$${line.Amount.toFixed(2)}`);
    }
  }

  if (unappliedCents !== 0) {
    lines.push('');
    lines.push(unappliedCents > 0
      ? `*** UNAPPLIED AMOUNT: $${formatDollars(unappliedCents)} — payment total exceeds applied lines`
      : `*** OVER-APPLIED: applied lines exceed payment total by $${formatDollars(-unappliedCents)}`);
  }

  lines.push('');
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`bill-payment-${bp.Id}`, bp, lines.join('\n'));
}
