// Line- and header-level entity attribution across the write tools.
//
// QBO spells "who is this line for" four different ways, and each tool used to
// get it wrong in its own direction: deposit lines could only be given a vendor
// on create and nothing at all on edit, journal entry lines had no entity
// support anywhere, and expense-style lines had no customer. These tests pin
// the payload shapes and, just as importantly, the preserve-on-line_id
// behaviour that a naive implementation would break.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { clearLookupCache, normalizeEntityKind } from "../../src/client/index.js";
import { handleCreateDeposit, handleEditDeposit } from "../../src/tools/handlers/deposit.js";
import {
  handleCreateJournalEntry,
  handleEditJournalEntry,
} from "../../src/tools/handlers/journal-entry.js";
import { handleCreateExpense } from "../../src/tools/handlers/expense.js";
import { handleCreateBill } from "../../src/tools/handlers/bill.js";

type Callback<T> = (err: unknown, result: T) => void;

const ACCOUNTS = [
  { Id: "10", Name: "Checking", FullyQualifiedName: "Checking", AcctNum: "1000", AccountType: "Bank" },
  { Id: "11", Name: "Clearing", FullyQualifiedName: "1234 Example Clearing", AcctNum: "1234" },
  { Id: "12", Name: "Supplies", FullyQualifiedName: "Supplies", AcctNum: "6000" },
  { Id: "13", Name: "Sales", FullyQualifiedName: "Sales", AcctNum: "4000" },
];

const VENDORS = [{ Id: "20", DisplayName: "Acme Supply Co" }];
const CUSTOMERS = [{ Id: "30", DisplayName: "Northwind Trading" }];
const EMPLOYEES = [{ Id: "40", DisplayName: "Pat Example" }];

// A deposit whose one line already carries a vendor. Anything that reprices this
// line without naming an entity must hand the same entity back.
const DEPOSIT_WITH_ENTITY = {
  Id: "500",
  SyncToken: "0",
  TxnDate: "2026-01-15",
  TotalAmt: 100.0,
  DepositToAccountRef: { value: "10", name: "Checking" },
  Line: [
    {
      Id: "1",
      LineNum: 1,
      Amount: 100.0,
      DetailType: "DepositLineDetail",
      DepositLineDetail: {
        AccountRef: { value: "13", name: "Sales" },
        Entity: { value: "20", name: "Acme Supply Co", type: "VENDOR" },
      },
    },
  ],
};

const JE_WITH_ENTITY = {
  Id: "600",
  SyncToken: "0",
  TxnDate: "2026-01-15",
  Line: [
    {
      Id: "0",
      LineNum: 1,
      Amount: 100.0,
      DetailType: "JournalEntryLineDetail",
      JournalEntryLineDetail: {
        PostingType: "Debit",
        AccountRef: { value: "12", name: "Supplies" },
        Entity: { Type: "Vendor", EntityRef: { value: "20", name: "Acme Supply Co" } },
      },
    },
    {
      Id: "1",
      LineNum: 2,
      Amount: 100.0,
      DetailType: "JournalEntryLineDetail",
      JournalEntryLineDetail: {
        PostingType: "Credit",
        AccountRef: { value: "11", name: "1234 Example Clearing" },
      },
    },
  ],
};

interface Sent {
  created: unknown[];
  updated: unknown[];
  customerQueries: unknown[];
}

// One fake standing in for every finder and writer the handlers reach for.
// `entity` seeds the read that edit handlers do first.
function fakeClient(entity?: Record<string, unknown>) {
  const sent: Sent = { created: [], updated: [], customerQueries: [] };
  const list = <T>(key: string, rows: T[]) => ({ QueryResponse: { [key]: rows } });

  const client = {
    findAccounts: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Account", ACCOUNTS)),
    findDepartments: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Department", [])),
    findClasses: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Class", [])),
    findVendors: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Vendor", VENDORS)),
    findEmployees: (_c: unknown, cb: Callback<unknown>) => cb(null, list("Employee", EMPLOYEES)),
    findCustomers: (criteria: unknown, cb: Callback<unknown>) => {
      sent.customerQueries.push(criteria);
      cb(null, list("Customer", CUSTOMERS));
    },
    getDeposit: (_id: string, cb: Callback<unknown>) => cb(null, entity),
    getJournalEntry: (_id: string, cb: Callback<unknown>) => cb(null, entity),
    createDeposit: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "501" });
    },
    updateDeposit: (body: unknown, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "500", SyncToken: "1" });
    },
    createJournalEntry: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "601" });
    },
    updateJournalEntry: (body: unknown, cb: Callback<unknown>) => {
      sent.updated.push(body);
      cb(null, { Id: "600", SyncToken: "1" });
    },
    createPurchase: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "701" });
    },
    createBill: (body: unknown, cb: Callback<unknown>) => {
      sent.created.push(body);
      cb(null, { Id: "801" });
    },
  } as unknown as QuickBooks;

  return { client, sent };
}

// Narrow the recorded payloads without `any` at every call site.
type Line = Record<string, Record<string, unknown>> & { Amount: number };
function linesOf(body: unknown): Line[] {
  return (body as { Line: Line[] }).Line;
}

beforeEach(() => {
  // The vendor/account/employee caches are module-level and TTL'd, so a fixture
  // from one test would otherwise answer a lookup in the next.
  clearLookupCache();
});

describe("normalizeEntityKind", () => {
  it("accepts any casing and returns the canonical form", () => {
    assert.equal(normalizeEntityKind("vendor"), "Vendor");
    assert.equal(normalizeEntityKind("CUSTOMER"), "Customer");
    assert.equal(normalizeEntityKind("Employee"), "Employee");
  });

  it("defaults to Vendor, which is what the tools assumed before entity_type", () => {
    assert.equal(normalizeEntityKind(undefined), "Vendor");
  });

  it("rejects an unknown type rather than passing it to QuickBooks", () => {
    assert.throws(() => normalizeEntityKind("Contractor"), /Invalid entity_type/);
  });
});

describe("create_deposit line entity", () => {
  it("writes a flat ReferenceType with an uppercase type", async () => {
    const { client, sent } = fakeClient();
    await handleCreateDeposit(client, {
      deposit_to_account: "1000",
      txn_date: "2026-01-15",
      draft: false,
      lines: [{ amount: 100.0, account_name: "4000", entity_name: "Acme Supply Co" }],
    });

    const detail = linesOf(sent.created[0])[0].DepositLineDetail;
    assert.deepEqual(detail.Entity, { value: "20", name: "Acme Supply Co", type: "VENDOR" });
  });

  it("resolves a customer when entity_type says Customer", async () => {
    const { client, sent } = fakeClient();
    await handleCreateDeposit(client, {
      deposit_to_account: "1000",
      txn_date: "2026-01-15",
      draft: false,
      lines: [
        {
          amount: 100.0,
          account_name: "4000",
          entity_name: "Northwind Trading",
          entity_type: "Customer",
        },
      ],
    });

    const detail = linesOf(sent.created[0])[0].DepositLineDetail;
    assert.deepEqual(detail.Entity, { value: "30", name: "Northwind Trading", type: "CUSTOMER" });
    // Customers are looked up on demand, not bulk-cached.
    assert.equal(sent.customerQueries.length, 1);
  });

  it("looks in the vendor list, not the customer list, when entity_type is omitted", async () => {
    const { client, sent } = fakeClient();
    await handleCreateDeposit(client, {
      deposit_to_account: "1000",
      txn_date: "2026-01-15",
      draft: false,
      lines: [{ amount: 100.0, account_name: "4000", entity_name: "Acme Supply Co" }],
    });

    assert.equal(sent.customerQueries.length, 0);
  });
});

describe("edit_deposit line entity", () => {
  it("preserves the existing entity when a line_id is repriced with no entity input", async () => {
    const { client, sent } = fakeClient(DEPOSIT_WITH_ENTITY);
    await handleEditDeposit(client, {
      id: "500",
      draft: false,
      lines: [{ line_id: "1", amount: 100.0, account_name: "4000" }],
    });

    const detail = linesOf(sent.updated[0])[0].DepositLineDetail;
    assert.deepEqual(detail.Entity, { value: "20", name: "Acme Supply Co", type: "VENDOR" });
  });

  it("sets an entity on a newly added line", async () => {
    const { client, sent } = fakeClient(DEPOSIT_WITH_ENTITY);
    await handleEditDeposit(client, {
      id: "500",
      draft: false,
      lines: [
        { line_id: "1", amount: 60.0, account_name: "4000" },
        { amount: 40.0, account_name: "1234", entity_name: "Acme Supply Co" },
      ],
    });

    const added = linesOf(sent.updated[0])[1];
    assert.equal(added.Id, undefined);
    assert.deepEqual(added.DepositLineDetail.Entity, {
      value: "20",
      name: "Acme Supply Co",
      type: "VENDOR",
    });
  });

  it("replaces the entity on an existing line when one is named", async () => {
    const { client, sent } = fakeClient(DEPOSIT_WITH_ENTITY);
    await handleEditDeposit(client, {
      id: "500",
      draft: false,
      lines: [
        {
          line_id: "1",
          amount: 100.0,
          account_name: "4000",
          entity_name: "Northwind Trading",
          entity_type: "Customer",
        },
      ],
    });

    const detail = linesOf(sent.updated[0])[0].DepositLineDetail;
    assert.deepEqual(detail.Entity, { value: "30", name: "Northwind Trading", type: "CUSTOMER" });
  });

  it("clears the entity when entity_name is empty", async () => {
    const { client, sent } = fakeClient(DEPOSIT_WITH_ENTITY);
    await handleEditDeposit(client, {
      id: "500",
      draft: false,
      lines: [{ line_id: "1", amount: 100.0, account_name: "4000", entity_name: "" }],
    });

    const detail = linesOf(sent.updated[0])[0].DepositLineDetail;
    assert.equal("Entity" in detail, false);
  });

  it("names the offending line when an entity cannot be resolved", async () => {
    const { client } = fakeClient(DEPOSIT_WITH_ENTITY);
    await assert.rejects(
      handleEditDeposit(client, {
        id: "500",
        draft: false,
        lines: [{ line_id: "1", amount: 100.0, account_name: "4000", entity_name: "Nobody At All" }],
      }),
      /Line 1: Vendor not found/
    );
  });
});

describe("journal entry line entity", () => {
  it("nests the ref in a Type/EntityRef pair, not a flat ReferenceType", async () => {
    const { client, sent } = fakeClient();
    await handleCreateJournalEntry(client, {
      txn_date: "2026-01-15",
      draft: false,
      lines: [
        {
          amount: 100.0,
          posting_type: "Debit",
          account_name: "6000",
          entity_name: "Acme Supply Co",
        },
        { amount: 100.0, posting_type: "Credit", account_name: "1234" },
      ],
    });

    const detail = linesOf(sent.created[0])[0].JournalEntryLineDetail;
    assert.deepEqual(detail.Entity, {
      Type: "Vendor",
      EntityRef: { value: "20", name: "Acme Supply Co" },
    });
    // The credit line named no entity, so it must not have grown one.
    assert.equal("Entity" in linesOf(sent.created[0])[1].JournalEntryLineDetail, false);
  });

  it("carries the entity type through for customers and employees", async () => {
    const { client, sent } = fakeClient();
    await handleCreateJournalEntry(client, {
      txn_date: "2026-01-15",
      draft: false,
      lines: [
        {
          amount: 100.0,
          posting_type: "Debit",
          account_name: "6000",
          entity_name: "Pat Example",
          entity_type: "Employee",
        },
        {
          amount: 100.0,
          posting_type: "Credit",
          account_name: "1234",
          entity_name: "Northwind Trading",
          entity_type: "Customer",
        },
      ],
    });

    const lines = linesOf(sent.created[0]);
    assert.deepEqual(lines[0].JournalEntryLineDetail.Entity, {
      Type: "Employee",
      EntityRef: { value: "40", name: "Pat Example" },
    });
    assert.deepEqual(lines[1].JournalEntryLineDetail.Entity, {
      Type: "Customer",
      EntityRef: { value: "30", name: "Northwind Trading" },
    });
  });

  it("preserves an existing line entity through an amount-only edit", async () => {
    const { client, sent } = fakeClient(JE_WITH_ENTITY);
    await handleEditJournalEntry(client, {
      id: "600",
      draft: false,
      lines: [
        { line_id: "0", amount: 250.0 },
        { line_id: "1", amount: 250.0 },
      ],
    });

    const detail = linesOf(sent.updated[0])[0].JournalEntryLineDetail;
    assert.deepEqual(detail.Entity, {
      Type: "Vendor",
      EntityRef: { value: "20", name: "Acme Supply Co" },
    });
  });

  it("sets an entity on a line added by an edit", async () => {
    const { client, sent } = fakeClient(JE_WITH_ENTITY);
    await handleEditJournalEntry(client, {
      id: "600",
      draft: false,
      lines: [
        { line_id: "0", amount: 50.0 },
        {
          amount: 50.0,
          posting_type: "Debit",
          account_name: "6000",
          entity_name: "Northwind Trading",
          entity_type: "Customer",
        },
      ],
    });

    const added = linesOf(sent.updated[0])[2];
    assert.deepEqual(added.JournalEntryLineDetail.Entity, {
      Type: "Customer",
      EntityRef: { value: "30", name: "Northwind Trading" },
    });
  });

  it("clears a line entity when entity_name is empty", async () => {
    const { client, sent } = fakeClient(JE_WITH_ENTITY);
    await handleEditJournalEntry(client, {
      id: "600",
      draft: false,
      lines: [{ line_id: "0", entity_name: "" }],
    });

    const detail = linesOf(sent.updated[0])[0].JournalEntryLineDetail;
    assert.equal("Entity" in detail, false);
  });
});

describe("expense payee and line customer", () => {
  it("keeps the header EntityRef type PascalCase, unlike a deposit line", async () => {
    const { client, sent } = fakeClient();
    await handleCreateExpense(client, {
      payment_type: "Check",
      payment_account: "1000",
      txn_date: "2026-01-15",
      draft: false,
      entity_name: "Pat Example",
      entity_type: "Employee",
      lines: [{ amount: 100.0, account_name: "6000" }],
    });

    const body = sent.created[0] as Record<string, unknown>;
    assert.deepEqual(body.EntityRef, { value: "40", name: "Pat Example", type: "Employee" });
  });

  it("still resolves the payee against vendors when entity_type is omitted", async () => {
    const { client, sent } = fakeClient();
    await handleCreateExpense(client, {
      payment_type: "Check",
      payment_account: "1000",
      txn_date: "2026-01-15",
      draft: false,
      entity_name: "Acme Supply Co",
      lines: [{ amount: 100.0, account_name: "6000" }],
    });

    const body = sent.created[0] as Record<string, unknown>;
    assert.deepEqual(body.EntityRef, { value: "20", name: "Acme Supply Co", type: "Vendor" });
  });

  it("attributes a line to a customer without queuing it for re-invoicing", async () => {
    const { client, sent } = fakeClient();
    await handleCreateExpense(client, {
      payment_type: "Check",
      payment_account: "1000",
      txn_date: "2026-01-15",
      draft: false,
      lines: [{ amount: 100.0, account_name: "6000", customer_name: "Northwind Trading" }],
    });

    const detail = linesOf(sent.created[0])[0].AccountBasedExpenseLineDetail;
    assert.deepEqual(detail.CustomerRef, { value: "30", name: "Northwind Trading" });
    assert.equal(detail.BillableStatus, "NotBillable");
  });
});

describe("bill line customer", () => {
  it("sets CustomerRef on the line detail", async () => {
    const { client, sent } = fakeClient();
    await handleCreateBill(client, {
      vendor_name: "Acme Supply Co",
      txn_date: "2026-01-15",
      draft: false,
      lines: [{ amount: 100.0, account_name: "6000", customer_name: "Northwind Trading" }],
    });

    const detail = linesOf(sent.created[0])[0].AccountBasedExpenseLineDetail;
    assert.deepEqual(detail.CustomerRef, { value: "30", name: "Northwind Trading" });
    assert.equal(detail.BillableStatus, "NotBillable");
  });

  it("leaves the line detail alone when no customer is named", async () => {
    const { client, sent } = fakeClient();
    await handleCreateBill(client, {
      vendor_name: "Acme Supply Co",
      txn_date: "2026-01-15",
      draft: false,
      lines: [{ amount: 100.0, account_name: "6000" }],
    });

    const detail = linesOf(sent.created[0])[0].AccountBasedExpenseLineDetail;
    assert.equal("CustomerRef" in detail, false);
  });
});
