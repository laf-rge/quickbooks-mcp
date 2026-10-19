import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { handleCreateVendor, handleEditVendor } from "../../src/tools/handlers/vendor.js";
import { executeTool } from "../../src/tools/index.js";

type Callback<T> = (err: unknown, result: T) => void;

const TERMS = [
  { Id: "1", Name: "Due on receipt" },
  { Id: "3", Name: "Net 30" },
];

const STORED = {
  Id: "42",
  SyncToken: "7",
  DisplayName: "Acme Supply Co",
  CompanyName: "Acme Supply Company",
  PrimaryEmailAddr: { Address: "ap@example.com" },
  BillAddr: { Id: "90", Line1: "1 Example Way", City: "Springfield", CountrySubDivisionCode: "ST", PostalCode: "00000" },
  AcctNum: "A-100",
  Vendor1099: false,
  Active: true,
};

function fakeClient() {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const client = {
    findTerms: (cb: Callback<unknown>) => cb(null, { QueryResponse: { Term: TERMS } }),
    getVendor: (_id: string, cb: Callback<unknown>) => cb(null, structuredClone(STORED)),
    createVendor: (v: Record<string, unknown>, cb: Callback<unknown>) => {
      created.push(v);
      cb(null, { Id: "100", SyncToken: "0", ...v });
    },
    updateVendor: (v: Record<string, unknown>, cb: Callback<unknown>) => {
      updated.push(v);
      cb(null, { ...STORED, ...v, SyncToken: "8" });
    },
  } as unknown as QuickBooks;
  return { client, created, updated };
}

describe("create_vendor", () => {
  it("previews without writing by default", async () => {
    const { client, created } = fakeClient();
    const text = (await handleCreateVendor(client, {
      display_name: "Acme Supply Co", term_ref: "net 30", vendor_1099: true,
    })).content[0].text;

    assert.match(text, /DRAFT/);
    assert.match(text, /Display Name: Acme Supply Co/);
    assert.match(text, /Terms: Net 30/);
    assert.match(text, /1099 Vendor: true/);
    assert.equal(created.length, 0);
  });

  it("sends only the fields given, with refs resolved", async () => {
    const { client, created } = fakeClient();
    const text = (await handleCreateVendor(client, {
      display_name: "Acme Supply Co",
      company_name: "Acme Supply Company",
      title: "Ms.",
      given_name: "Pat",
      family_name: "Lee",
      email: "ap@example.com",
      phone: "555-0100",
      bill_address: { line1: "1 Example Way", city: "Springfield", state: "ST", postal_code: "00000" },
      term_ref: "3",
      account_number: "A-100",
      vendor_1099: false,
      draft: false,
    })).content[0].text;

    assert.deepEqual(created[0], {
      DisplayName: "Acme Supply Co",
      CompanyName: "Acme Supply Company",
      Title: "Ms.",
      GivenName: "Pat",
      FamilyName: "Lee",
      PrimaryEmailAddr: { Address: "ap@example.com" },
      PrimaryPhone: { FreeFormNumber: "555-0100" },
      BillAddr: { Line1: "1 Example Way", City: "Springfield", CountrySubDivisionCode: "ST", PostalCode: "00000" },
      TermRef: { value: "3", name: "Net 30" },
      AcctNum: "A-100",
      Vendor1099: false,
    });
    assert.match(text, /Vendor Created!/);
    assert.match(text, /ID: 100/);
    assert.match(text, /vendordetail\?nameId=100/);
  });

  it("rejects an unknown term and lists the real ones", async () => {
    const { client, created } = fakeClient();
    await assert.rejects(
      handleCreateVendor(client, { display_name: "Acme Supply Co", term_ref: "Net 45", draft: false }),
      /Term not found: "Net 45"\. Available: Due on receipt, Net 30/
    );
    assert.equal(created.length, 0);
  });
});

describe("edit_vendor", () => {
  it("sends a sparse update carrying only the changed fields", async () => {
    const { client, updated } = fakeClient();
    await handleEditVendor(client, { id: "42", account_number: "A-200", vendor_1099: true, draft: false });

    assert.deepEqual(updated[0], {
      Id: "42",
      SyncToken: "7",
      sparse: true,
      AcctNum: "A-200",
      Vendor1099: true,
    });
  });

  it("merges a partial address over the stored one", async () => {
    const { client, updated } = fakeClient();
    await handleEditVendor(client, { id: "42", bill_address: { postal_code: "11111" }, draft: false });

    assert.deepEqual(updated[0].BillAddr, {
      Id: "90", Line1: "1 Example Way", City: "Springfield", CountrySubDivisionCode: "ST", PostalCode: "11111",
    });
  });

  it("deactivates with active=false", async () => {
    const { client, updated } = fakeClient();
    const text = (await handleEditVendor(client, { id: "42", active: false, draft: false })).content[0].text;

    assert.equal(updated[0].Active, false);
    assert.match(text, /Vendor 42 updated successfully/);
    assert.match(text, /New SyncToken: 8/);
  });

  it("previews before and after without writing", async () => {
    const { client, updated } = fakeClient();
    const text = (await handleEditVendor(client, { id: "42", phone: "555-0199", term_ref: "Net 30" })).content[0].text;

    assert.equal(updated.length, 0);
    assert.match(text, /DRAFT - Vendor Edit Preview/);
    assert.match(text, /ID: 42 \(Acme Supply Co\)/);
    assert.match(text, /Before:\n {2}Phone: \(none\)\n {2}Terms: \(none\)\nAfter:\n {2}Phone: 555-0199\n {2}Terms: Net 30/);
    assert.doesNotMatch(text, /Account Number/);
  });
});

// Validation runs before a client is requested, so these need no credentials.
describe("vendor tools — argument validation", () => {
  it("refuses a misspelled parameter with a suggestion", async () => {
    const result = await executeTool("create_vendor", { display_name: "Acme Supply Co", acct_num: "A-100" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown parameter "acct_num"/);
  });

  it("refuses an unknown address key", async () => {
    const result = await executeTool("edit_vendor", { id: "42", bill_address: { zip: "00000" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown parameter "zip" at "bill_address"/);
  });

  it("refuses notes, which the Vendor API does not accept", async () => {
    const result = await executeTool("edit_vendor", { id: "42", notes: "call first" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown parameter "notes"/);
  });

  it("refuses an edit with nothing to change", async () => {
    const result = await executeTool("edit_vendor", { id: "42", draft: false });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no fields to change/);
  });

  it("requires display_name on create", async () => {
    const result = await executeTool("create_vendor", { company_name: "Acme Supply Company" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Missing required parameter "display_name"/);
  });
});
