import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { handleCreateTransfer } from "../../src/tools/handlers/transfer.js";
import { clearLookupCache } from "../../src/client/cache.js";

type Callback<T> = (err: unknown, result: T) => void;

// "Operating Credit" is a Bank account whose name contains "Credit". A real
// chart of accounts has one, which is why the account-type restriction matters:
// an unrestricted match for "Credit" could land on it or on a card.
const ACCOUNTS = [
  { Id: "10", Name: "Checking", FullyQualifiedName: "1010 Checking", AcctNum: "1010", AccountType: "Bank", Classification: "Asset" },
  { Id: "11", Name: "Savings", FullyQualifiedName: "1020 Savings", AcctNum: "1020", AccountType: "Bank", Classification: "Asset" },
  { Id: "12", Name: "Operating Credit", FullyQualifiedName: "1030 Operating Credit", AcctNum: "1030", AccountType: "Bank", Classification: "Asset" },
  { Id: "20", Name: "Company Card", FullyQualifiedName: "2100 Company Card", AcctNum: "2100", AccountType: "Credit Card", Classification: "Liability" },
  { Id: "60", Name: "Office Supplies", FullyQualifiedName: "6000 Office Supplies", AcctNum: "6000", AccountType: "Expense", Classification: "Expense" },
];

function fakeClient() {
  const sent: Record<string, unknown>[] = [];
  const client = {
    findAccounts: (_c: object, cb: Callback<unknown>) => cb(null, { QueryResponse: { Account: ACCOUNTS } }),
    createTransfer: (transfer: Record<string, unknown>, cb: Callback<unknown>) => {
      sent.push(transfer);
      cb(null, { Id: "500" });
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

const base = { amount: 250, txn_date: "2026-07-15" };

beforeEach(() => clearLookupCache());

describe("create_transfer — the draft preview", () => {
  it("says which way the money moves", async () => {
    const { client } = fakeClient();
    const text = (await handleCreateTransfer(client, {
      ...base, from_account: "1010", to_account: "1020",
    })).content[0].text;

    assert.match(text, /DRAFT/);
    assert.match(text, /From: 1010 Checking/);
    assert.match(text, /To:\s+1020 Savings/);
    assert.match(text, /1010 Checking decreases by \$250\.00/);
    assert.match(text, /1020 Savings increases/);
  });

  it("records nothing while drafting", async () => {
    const { client, sent } = fakeClient();
    await handleCreateTransfer(client, { ...base, from_account: "1010", to_account: "1020" });
    assert.equal(sent.length, 0);
  });
});

describe("create_transfer — what it sends", () => {
  it("sends both refs and a positive amount", async () => {
    const { client, sent } = fakeClient();
    await handleCreateTransfer(client, {
      ...base, from_account: "1010", to_account: "1020", private_note: "sweep", draft: false,
    });
    assert.deepEqual(sent[0], {
      FromAccountRef: { value: "10", name: "1010 Checking" },
      ToAccountRef: { value: "11", name: "1020 Savings" },
      Amount: 250,
      TxnDate: "2026-07-15",
      PrivateNote: "sweep",
    });
  });

  it("moves money to a credit card, which is how a paydown is recorded", async () => {
    const { client, sent } = fakeClient();
    await handleCreateTransfer(client, {
      ...base, from_account: "1010", to_account: "2100", draft: false,
    });
    assert.deepEqual((sent[0] as Record<string, unknown>).ToAccountRef, { value: "20", name: "2100 Company Card" });
  });

  it("omits the note when there is none", async () => {
    const { client, sent } = fakeClient();
    await handleCreateTransfer(client, { ...base, from_account: "1010", to_account: "1020", draft: false });
    assert.ok(!("PrivateNote" in (sent[0] as object)));
  });
});

describe("create_transfer — what it refuses", () => {
  it("refuses a transfer to the same account", async () => {
    // QBO rejects this too, with "Duplicate From and To Accounts", but only
    // after the round trip and without naming the account.
    const { client } = fakeClient();
    const message = await reject(() =>
      handleCreateTransfer(client, { ...base, from_account: "1010", to_account: "1010" })
    );
    assert.match(message, /both resolve to "1010 Checking"/);
  });

  it("refuses two different names that resolve to one account", async () => {
    // The check has to be on the resolved ids: "1010" and "Checking" are not the
    // same string and are the same account.
    const { client } = fakeClient();
    const message = await reject(() =>
      handleCreateTransfer(client, { ...base, from_account: "1010", to_account: "Checking" })
    );
    assert.match(message, /must move money between two different accounts/);
  });

  it("refuses an account that is neither a bank nor a card", async () => {
    const { client } = fakeClient();
    const message = await reject(() =>
      handleCreateTransfer(client, { ...base, from_account: "6000", to_account: "1010" })
    );
    assert.match(message, /must name a Bank or Credit Card account/);
  });

  it("refuses a non-positive amount rather than letting QBO say 'Number out of range'", async () => {
    const { client } = fakeClient();
    for (const amount of [0, -5]) {
      const message = await reject(() =>
        handleCreateTransfer(client, { ...base, amount, from_account: "1010", to_account: "1020" })
      );
      assert.match(message, /must be positive/);
    }
  });

  it("accepts an account id, but only after number and name have missed", async () => {
    // resolveAccountRef matches number, then name, then a partial name — never
    // Id, which elsewhere is a separate account_id parameter. A transfer takes
    // one parameter per side, so an id is a last resort here.
    const { client, sent } = fakeClient();
    await handleCreateTransfer(client, {
      ...base, from_account: "20", to_account: "1010", draft: false,
    });
    assert.deepEqual((sent[0] as Record<string, unknown>).FromAccountRef, { value: "20", name: "2100 Company Card" });
  });

  it("lets an account number win over another account's id", async () => {
    // "1010" is Checking's account number and nobody's id; it must not be
    // reinterpreted as one.
    const { client, sent } = fakeClient();
    await handleCreateTransfer(client, {
      ...base, from_account: "1010", to_account: "20", draft: false,
    });
    assert.deepEqual((sent[0] as Record<string, unknown>).FromAccountRef, { value: "10", name: "1010 Checking" });
  });

  it("refuses an id that belongs to an account it may not touch", async () => {
    const { client } = fakeClient();
    const message = await reject(() =>
      handleCreateTransfer(client, { ...base, from_account: "60", to_account: "1010" })
    );
    assert.match(message, /must name a Bank or Credit Card account/);
  });

  it("still reaches a Bank account whose name contains 'Credit'", async () => {
    // The type restriction tries Bank before Credit Card, so a bank account
    // named like a card must still resolve to itself.
    const { client, sent } = fakeClient();
    await handleCreateTransfer(client, {
      ...base, from_account: "Operating Credit", to_account: "1010", draft: false,
    });
    assert.deepEqual((sent[0] as Record<string, unknown>).FromAccountRef, { value: "12", name: "1030 Operating Credit" });
  });
});
