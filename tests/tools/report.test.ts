import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { handleGetReport } from "../../src/tools/handlers/report.js";
import { setOutputMode } from "../../src/utils/output.js";

before(() => setOutputMode("http"));

type Callback<T> = (err: unknown, result: T) => void;

const REPORT = {
  Header: { ReportName: "AgedPayables", EndPeriod: "2026-06-30" },
  Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Current" }, { ColTitle: "Total" }] },
  Rows: { Row: [{ ColData: [{ value: "North Supply" }, { value: "100.00" }, { value: "100.00" }] }] },
};

// Records what criteria the handler passed, so the tests can assert on the
// query QBO would have received.
function fakeClient() {
  const seen: Record<string, Record<string, string>> = {};
  const stub = (method: string) => (options: Record<string, string>, cb: Callback<unknown>) => {
    seen[method] = options;
    cb(null, REPORT);
  };
  const client = {
    reportAgedPayables: stub("reportAgedPayables"),
    reportGeneralLedgerDetail: stub("reportGeneralLedgerDetail"),
    reportTransactionList: stub("reportTransactionList"),
  } as unknown as QuickBooks;
  return { client, seen };
}

async function reject(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected the call to be rejected");
}

describe("handleGetReport — choosing a report", () => {
  it("runs the report named", async () => {
    const { client, seen } = fakeClient();
    const result = await handleGetReport(client, { report: "aged_payables", report_date: "2026-06-30" });
    assert.ok(seen.reportAgedPayables);
    assert.match(result.content[0].text, /Current/);
  });

  it("accepts QuickBooks' own spelling", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, { report: "AgedPayables" });
    assert.ok(seen.reportAgedPayables);
  });

  it("names the closest report when the name is wrong", async () => {
    const { client } = fakeClient();
    const message = await reject(() => handleGetReport(client, { report: "aged_payable" }));
    assert.match(message, /Did you mean "aged_payables"/);
  });

  it("points at the dedicated tool for a report it deliberately omits", async () => {
    const { client } = fakeClient();
    const message = await reject(() => handleGetReport(client, { report: "profit_and_loss" }));
    assert.match(message, /get_profit_loss/);
  });

  it("refuses to run with no report named", async () => {
    const { client } = fakeClient();
    const message = await reject(() => handleGetReport(client, {}));
    assert.match(message, /Missing required parameter "report"/);
  });
});

describe("handleGetReport — dating a report", () => {
  it("dates a point-in-time report with report_date", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, { report: "aged_payables", report_date: "2026-06-30" });
    assert.deepEqual(seen.reportAgedPayables, { report_date: "2026-06-30" });
  });

  it("takes end_date as the as-of date rather than answering as of today", async () => {
    // A caller who reaches for the range parameter on an aging report would
    // otherwise get a silently different report than the one asked for.
    const { client, seen } = fakeClient();
    await handleGetReport(client, { report: "aged_payables", end_date: "2026-06-30" });
    assert.deepEqual(seen.reportAgedPayables, { report_date: "2026-06-30" });
  });

  it("rejects report_date on a report that covers a range", async () => {
    const { client } = fakeClient();
    const message = await reject(() =>
      handleGetReport(client, { report: "general_ledger", report_date: "2026-06-30" })
    );
    assert.match(message, /covers a date range/);
  });

  it("passes a range through for a range report", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, {
      report: "general_ledger", start_date: "2026-06-01", end_date: "2026-06-30",
      accounting_method: "Cash", summarize_by: "Month",
    });
    assert.deepEqual(seen.reportGeneralLedgerDetail, {
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      accounting_method: "Cash",
      summarize_column_by: "Month",
    });
  });
});

describe("handleGetReport — criteria that would corrupt the query", () => {
  // node-quickbooks concatenates report criteria into the URL without encoding
  // anything, so an unescaped separator in a value does not arrive as a value —
  // it adds criteria of its own.
  it("rejects a value carrying a query separator", async () => {
    const { client } = fakeClient();
    for (const bad of ["2026-06-30&customer=9", "Cash=x", "a?b", "a#b"]) {
      const message = await reject(() =>
        handleGetReport(client, { report: "aged_payables", report_date: bad })
      );
      assert.match(message, /report criteria may contain only/);
    }
  });

  it("allows the punctuation a legitimate date or macro uses", async () => {
    const { client, seen } = fakeClient();
    await handleGetReport(client, { report: "general_ledger", date_macro: "This Fiscal Year-to-date" });
    assert.equal(seen.reportGeneralLedgerDetail.date_macro, "This Fiscal Year-to-date");
  });
});

describe("handleGetReport — response size", () => {
  const wide = {
    Header: { ReportName: "TransactionList" },
    Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Amount" }] },
    Rows: { Row: Array.from({ length: 3000 }, (_, i) => ({ ColData: [{ value: `Row ${i}` }, { value: "1.00" }] })) },
  };

  function bigClient(): QuickBooks {
    return {
      reportTransactionList: (_o: object, cb: Callback<unknown>) => cb(null, wide),
    } as unknown as QuickBooks;
  }

  it("caps the table by default", async () => {
    const result = await handleGetReport(bigClient(), { report: "transaction_list" });
    assert.equal(result.content[0].text.split("\n").filter(l => l.startsWith("Row ")).length, 200);
  });

  it("honours a raised max_rows", async () => {
    const result = await handleGetReport(bigClient(), { report: "transaction_list", max_rows: 500 });
    assert.equal(result.content[0].text.split("\n").filter(l => l.startsWith("Row ")).length, 500);
  });

  it("holds max_rows to a ceiling, so the summary stays a summary", async () => {
    const result = await handleGetReport(bigClient(), { report: "transaction_list", max_rows: 99999 });
    assert.equal(result.content[0].text.split("\n").filter(l => l.startsWith("Row ")).length, 2000);
  });

  it("withholds the raw payload unless asked", async () => {
    const plain = await handleGetReport(bigClient(), { report: "transaction_list" });
    assert.equal(plain.content.length, 1);
    const raw = await handleGetReport(bigClient(), { report: "transaction_list", include_raw: true });
    assert.equal(raw.content.length, 2);
  });
});
