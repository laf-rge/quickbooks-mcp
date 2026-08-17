import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { handleGetTrialBalance } from "../../src/tools/handlers/reports.js";
import { setOutputMode } from "../../src/utils/output.js";
import { clearLookupCache } from "../../src/client/cache.js";

// Inline output keeps the test off the filesystem; the summary is content[0].
before(() => setOutputMode("http"));

type Callback<T> = (err: unknown, result: T) => void;

const REPORT = {
  Header: { ReportName: "TrialBalance", StartPeriod: "2026-06-01", EndPeriod: "2026-06-30" },
  Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Debit" }, { ColTitle: "Credit" }] },
  Rows: {
    Row: [
      { ColData: [{ value: "1010 Checking", id: "1" }, { value: "" }, { value: "250.00" }] },
      {
        Summary: { ColData: [{ value: "TOTAL" }, { value: "250.00" }, { value: "250.00" }] },
        type: "Section",
        group: "GrandTotal",
      },
    ],
  },
};

const ACCOUNTS = [
  { Id: "1", Name: "Checking", AcctNum: "1010", Classification: "Asset", AccountType: "Bank" },
];

// A stand-in for the QuickBooks client covering only the two calls this handler
// makes, so the handler runs for real without a network or credentials.
function fakeClient(opts: { accountsFail?: string } = {}): QuickBooks {
  return {
    reportTrialBalance: (_options: object, cb: Callback<unknown>) => cb(null, REPORT),
    findAccounts: (_criteria: object, cb: Callback<unknown>) =>
      opts.accountsFail
        ? cb(new Error(opts.accountsFail), null)
        : cb(null, { QueryResponse: { Account: ACCOUNTS } }),
  } as unknown as QuickBooks;
}

describe("handleGetTrialBalance", () => {
  it("leaves the report untouched when flags are not requested", async () => {
    clearLookupCache();
    const result = await handleGetTrialBalance(fakeClient(), {});
    assert.doesNotMatch(result.content[0].text, /FLAGS/);
    assert.match(result.content[0].text, /1010 Checking/);
  });

  it("appends the flag pass when flags is set", async () => {
    clearLookupCache();
    const result = await handleGetTrialBalance(fakeClient(), { flags: true });
    assert.match(result.content[0].text, /FLAGS/);
    assert.match(result.content[0].text, /1010 Checking\s+250\.00 CR\s+Asset, normally debit/);
  });

  it("still returns the report when the chart of accounts cannot be fetched", async () => {
    // The report is the deliverable and the flags are an extra, so a failed
    // account fetch degrades to a note rather than failing the whole call.
    clearLookupCache();
    const result = await handleGetTrialBalance(fakeClient({ accountsFail: "429 throttled" }), {
      flags: true,
    });
    assert.match(result.content[0].text, /1010 Checking/);
    assert.match(result.content[0].text, /FLAGS unavailable: .*429 throttled/);
  });
});
