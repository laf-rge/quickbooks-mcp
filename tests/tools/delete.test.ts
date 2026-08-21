import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { handleDeleteEntity } from "../../src/tools/handlers/delete.js";

type Callback<T> = (err: unknown, result: T) => void;

// A read of an expense comes back with read-only extension blocks QBO will not
// accept as input. Echoing this body back at the delete endpoint is what used to
// fail validation, so the fixture keeps one to prove it never leaves.
const EXPENSE = {
  Id: "42",
  SyncToken: "3",
  TxnDate: "2026-06-15",
  PaymentType: "Check",
  TotalAmt: 100.0,
  EntityRef: { value: "7", name: "Acme Supply" },
  PrivateNote: "Synthetic fixture",
  PurchaseEx: {
    any: [
      {
        name: "{http://schema.intuit.com/finance/v3}NameValue",
        declaredType: "com.intuit.schema.finance.v3.NameValue",
        scope: "javax.xml.bind.JAXBElement$GlobalScope",
        value: { Name: "TxnType", Value: "54" },
        nil: false,
        globalScope: true,
        typeSubstituted: false,
      },
    ],
  },
};

// Stands in for the client across the two calls the handler makes, recording
// whatever was handed to the delete method.
function fakeClient(entity: Record<string, unknown> | null) {
  const calls: { reads: string[]; deleted: unknown[] } = { reads: [], deleted: [] };
  const client = {
    getPurchase: (id: string, cb: Callback<unknown>) => {
      calls.reads.push(id);
      cb(null, entity);
    },
    deletePurchase: (idOrEntity: unknown, cb: Callback<unknown>) => {
      calls.deleted.push(idOrEntity);
      cb(null, { Purchase: { Id: "42", status: "Deleted" } });
    },
  } as unknown as QuickBooks;
  return { client, calls };
}

describe("handleDeleteEntity", () => {
  it("previews without deleting when confirm is not set", async () => {
    const { client, calls } = fakeClient(EXPENSE);
    const result = await handleDeleteEntity(client, { entity_type: "expense", id: "42" });

    assert.equal(calls.deleted.length, 0);
    assert.match(result.content[0].text, /Expense #42 — Acme Supply/);
    assert.match(result.content[0].text, /confirm=true/);
  });

  it("deletes with a minimal Id + SyncToken body, never the read entity", async () => {
    const { client, calls } = fakeClient(EXPENSE);
    await handleDeleteEntity(client, { entity_type: "expense", id: "42", confirm: true });

    assert.equal(calls.deleted.length, 1);
    const body = calls.deleted[0];
    // An object, not the bare id string: a string makes node-quickbooks re-read
    // the entity and post the whole thing back.
    assert.equal(typeof body, "object");
    assert.deepEqual(body, { Id: "42", SyncToken: "3" });
    // Belt and braces: nothing from the read leaked into the request.
    assert.doesNotMatch(JSON.stringify(body), /PurchaseEx|javax\.xml\.bind/);
  });

  it("reads the entity once, not once per path", async () => {
    const { client, calls } = fakeClient(EXPENSE);
    await handleDeleteEntity(client, { entity_type: "expense", id: "42", confirm: true });
    assert.deepEqual(calls.reads, ["42"]);
  });

  it("coerces a numeric SyncToken to a string", async () => {
    const { client, calls } = fakeClient({ ...EXPENSE, Id: 42, SyncToken: 0 });
    await handleDeleteEntity(client, { entity_type: "expense", id: "42", confirm: true });
    assert.deepEqual(calls.deleted[0], { Id: "42", SyncToken: "0" });
  });

  it("falls back to SyncToken 0 when the read carries none", async () => {
    const { client, calls } = fakeClient({ Id: "42", SyncToken: "  ", TxnDate: "2026-06-15" });
    await handleDeleteEntity(client, { entity_type: "expense", id: "42", confirm: true });
    assert.deepEqual(calls.deleted[0], { Id: "42", SyncToken: "0" });
  });

  it("refuses to delete when the read returns no Id", async () => {
    const { client, calls } = fakeClient({ SyncToken: "3" });
    await assert.rejects(
      () => handleDeleteEntity(client, { entity_type: "expense", id: "42", confirm: true }),
      /no Id/
    );
    assert.equal(calls.deleted.length, 0);
  });

  it("rejects an unknown entity_type before touching the API", async () => {
    const { client, calls } = fakeClient(EXPENSE);
    await assert.rejects(
      () => handleDeleteEntity(client, { entity_type: "widget", id: "42", confirm: true }),
      /Invalid entity_type/
    );
    assert.equal(calls.reads.length, 0);
  });
});
