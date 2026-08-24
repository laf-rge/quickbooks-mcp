import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { handleReceivePayment } from "../../src/tools/handlers/payment.js";
import { clearLookupCache } from "../../src/client/cache.js";

type Callback<T> = (err: unknown, result: T) => void;

const ACCOUNTS = [
  { Id: "10", Name: "Checking", FullyQualifiedName: "1010 Checking", AcctNum: "1010", AccountType: "Bank", Classification: "Asset" },
  { Id: "4", Name: "Undeposited Funds", FullyQualifiedName: "Undeposited Funds", AccountType: "Other Current Asset", AccountSubType: "UndepositedFunds", Classification: "Asset" },
  { Id: "60", Name: "Office Supplies", FullyQualifiedName: "6000 Office Supplies", AcctNum: "6000", AccountType: "Expense", Classification: "Expense" },
];

const CUSTOMERS = [
  { Id: "1", DisplayName: "North Cafe" },
  { Id: "2", DisplayName: "South Diner" },
];

const INVOICES: Record<string, unknown> = {
  "100": { Id: "100", DocNumber: "INV-1", TxnDate: "2026-07-01", TotalAmt: 250, Balance: 250, CustomerRef: { value: "1", name: "North Cafe" } },
  "101": { Id: "101", DocNumber: "INV-2", TxnDate: "2026-07-02", TotalAmt: 100, Balance: 40, CustomerRef: { value: "1", name: "North Cafe" } },
  "102": { Id: "102", DocNumber: "INV-3", TxnDate: "2026-07-03", TotalAmt: 75, Balance: 0, CustomerRef: { value: "1", name: "North Cafe" } },
  "200": { Id: "200", DocNumber: "INV-9", TxnDate: "2026-07-04", TotalAmt: 500, Balance: 500, CustomerRef: { value: "2", name: "South Diner" } },
};

function fakeClient() {
  const sent: Record<string, unknown>[] = [];
  const client = {
    findAccounts: (_c: object, cb: Callback<unknown>) => cb(null, { QueryResponse: { Account: ACCOUNTS } }),
    findCustomers: (_c: object, cb: Callback<unknown>) => cb(null, { QueryResponse: { Customer: CUSTOMERS } }),
    findPaymentMethods: (cb: Callback<unknown>) =>
      cb(null, { QueryResponse: { PaymentMethod: [{ Id: "2", Name: "Check" }, { Id: "1", Name: "Cash" }] } }),
    getInvoice: (id: string, cb: Callback<unknown>) =>
      INVOICES[id] ? cb(null, INVOICES[id]) : cb(new Error(`Invoice ${id} not found`), null),
    createPayment: (payment: Record<string, unknown>, cb: Callback<unknown>) => {
      sent.push(payment);
      cb(null, { Id: "900", UnappliedAmt: 0 });
    },
  } as unknown as QuickBooks;
  return { client, sent };
}

async function reject(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the call to be rejected");
}

const base = { customer_name: "North Cafe", txn_date: "2026-07-15" };

beforeEach(() => clearLookupCache());

describe("receive_payment — the draft preview", () => {
  it("shows what each invoice owes, what is applied, and what is left", async () => {
    const { client } = fakeClient();
    const text = (await handleReceivePayment(client, {
      ...base, invoices: [{ invoice_id: "100", amount: 100 }],
    })).content[0].text;

    assert.match(text, /DRAFT/);
    assert.match(text, /open \$250\.00/);
    assert.match(text, /applying \$100\.00/);
    assert.match(text, /remaining \$150\.00/);
  });

  it("does not record anything while drafting", async () => {
    const { client, sent } = fakeClient();
    await handleReceivePayment(client, { ...base, invoices: [{ invoice_id: "100" }] });
    assert.equal(sent.length, 0);
  });

  it("names the QuickBooks default when no deposit account is given", async () => {
    const { client } = fakeClient();
    const text = (await handleReceivePayment(client, { ...base, invoices: [{ invoice_id: "100" }] })).content[0].text;
    assert.match(text, /Undeposited Funds/);
  });
});

describe("receive_payment — what it applies", () => {
  it("defaults each line to the invoice's open balance", async () => {
    const { client, sent } = fakeClient();
    await handleReceivePayment(client, {
      ...base, draft: false, invoices: [{ invoice_id: "100" }, { invoice_id: "101" }],
    });
    const payment = sent[0] as { TotalAmt: number; Line: Array<{ Amount: number; LinkedTxn: Array<{ TxnId: string; TxnType: string }> }> };
    // 250 open on one, 40 remaining on the other — not its 100 total.
    assert.equal(payment.TotalAmt, 290);
    assert.deepEqual(payment.Line.map(l => l.Amount), [250, 40]);
    assert.deepEqual(payment.Line[0].LinkedTxn[0], { TxnId: "100", TxnType: "Invoice" });
  });

  it("omits DepositToAccountRef entirely when not asked for", async () => {
    const { client, sent } = fakeClient();
    await handleReceivePayment(client, { ...base, draft: false, invoices: [{ invoice_id: "100" }] });
    assert.ok(!("DepositToAccountRef" in (sent[0] as object)));
  });

  it("carries the reference number and payment method through", async () => {
    const { client, sent } = fakeClient();
    await handleReceivePayment(client, {
      ...base, draft: false, invoices: [{ invoice_id: "100" }],
      payment_method: "Check", reference_no: "4471", memo: "July remittance",
    });
    const p = sent[0] as Record<string, unknown>;
    assert.equal(p.PaymentRefNum, "4471");
    assert.deepEqual(p.PaymentMethodRef, { value: "2", name: "Check" });
    assert.equal(p.PrivateNote, "July remittance");
  });
});

describe("receive_payment — what it refuses", () => {
  it("refuses an invoice belonging to another customer", async () => {
    // QBO does reject this, but only with "TxnID Cannot Be Linked", which names
    // neither the invoice nor whose it is.
    const { client } = fakeClient();
    const message = await reject(() =>
      handleReceivePayment(client, { ...base, invoices: [{ invoice_id: "200" }] })
    );
    assert.match(message, /belongs to customer "South Diner", not "North Cafe"/);
  });

  it("refuses to apply more than an invoice owes", async () => {
    const { client } = fakeClient();
    const message = await reject(() =>
      handleReceivePayment(client, { ...base, invoices: [{ invoice_id: "101", amount: 60 }] })
    );
    assert.match(message, /exceeds open balance \$40\.00/);
  });

  it("refuses an invoice that is already settled", async () => {
    const { client } = fakeClient();
    const message = await reject(() =>
      handleReceivePayment(client, { ...base, invoices: [{ invoice_id: "102" }] })
    );
    assert.match(message, /no open balance/);
  });

  it("refuses a total smaller than what is being applied", async () => {
    const { client } = fakeClient();
    const message = await reject(() =>
      handleReceivePayment(client, { ...base, invoices: [{ invoice_id: "100" }], amount: 200 })
    );
    assert.match(message, /less than the \$250\.00 being applied/);
  });

  it("refuses with no invoices at all", async () => {
    const { client } = fakeClient();
    assert.match(await reject(() => handleReceivePayment(client, { ...base, invoices: [] })), /At least one invoice/);
  });
});

describe("receive_payment — the deposit account", () => {
  it("takes a bank account", async () => {
    const { client, sent } = fakeClient();
    await handleReceivePayment(client, {
      ...base, draft: false, invoices: [{ invoice_id: "100" }], deposit_to_account: "1010",
    });
    assert.deepEqual((sent[0] as Record<string, unknown>).DepositToAccountRef, { value: "10", name: "1010 Checking" });
  });

  it("takes Undeposited Funds, which is what QuickBooks itself defaults to", async () => {
    // The Bank-type restriction that guards the money-moving tools would refuse
    // the product's own default, so this exception has to be real.
    const { client, sent } = fakeClient();
    await handleReceivePayment(client, {
      ...base, draft: false, invoices: [{ invoice_id: "100" }], deposit_to_account: "Undeposited Funds",
    });
    assert.deepEqual((sent[0] as Record<string, unknown>).DepositToAccountRef, { value: "4", name: "Undeposited Funds" });
  });

  it("refuses an account that is neither", async () => {
    const { client } = fakeClient();
    const message = await reject(() =>
      handleReceivePayment(client, {
        ...base, invoices: [{ invoice_id: "100" }], deposit_to_account: "6000",
      })
    );
    assert.match(message, /No Bank-type account matches/);
  });
});

describe("receive_payment — overpayment", () => {
  it("says an unapplied credit will be left, rather than leaving it to be discovered", async () => {
    // Confirmed against a live company: QBO accepts a payment larger than what
    // it settles and parks the remainder as an unapplied credit.
    const { client } = fakeClient();
    const text = (await handleReceivePayment(client, {
      ...base, invoices: [{ invoice_id: "101" }], amount: 100,
    })).content[0].text;
    assert.match(text, /UNAPPLIED: \$60\.00/);
    assert.match(text, /North Cafe/);
  });

  it("says nothing about unapplied credit when everything is applied", async () => {
    const { client } = fakeClient();
    const text = (await handleReceivePayment(client, { ...base, invoices: [{ invoice_id: "101" }] })).content[0].text;
    assert.doesNotMatch(text, /UNAPPLIED/);
  });
});
