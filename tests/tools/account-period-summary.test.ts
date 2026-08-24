import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseGLReport, normalBalance } from "../../src/tools/handlers/account-period-summary.js";

// A General Ledger section with an opening balance and a set of movements.
// `Amount` is signed by which way the account's balance moved — positive up,
// negative down — in every classification. See docs/quickbooks-api-limitations.md.
function gl(opening: string, amounts: number[]) {
  return {
    Columns: {
      Column: [
        { ColTitle: "Date" }, { ColTitle: "Transaction Type" }, { ColTitle: "Num" },
        { ColTitle: "Name" }, { ColTitle: "Memo/Description" }, { ColTitle: "Split" },
        { ColTitle: "Amount" }, { ColTitle: "Balance" },
      ],
    },
    Rows: {
      Row: [
        {
          type: "Section",
          Rows: {
            Row: [
              {
                type: "Data",
                ColData: [
                  { value: "Beginning Balance" }, { value: "" }, { value: "" }, { value: "" },
                  { value: "" }, { value: "" }, { value: "" }, { value: opening },
                ],
              },
              ...amounts.map(a => ({
                type: "Data",
                ColData: [
                  { value: "2026-07-15" }, { value: "Expense" }, { value: "" }, { value: "" },
                  { value: "" }, { value: "" }, { value: a.toFixed(2) }, { value: "0.00" },
                ],
              })),
            ],
          },
        },
      ],
    },
  };
}

describe("normalBalance", () => {
  it("puts a rise on the debit side for assets and expenses", () => {
    assert.equal(normalBalance("Asset"), "debit");
    assert.equal(normalBalance("Expense"), "debit");
  });

  it("puts a rise on the credit side for everything else", () => {
    for (const cls of ["Liability", "Equity", "Revenue", undefined]) {
      assert.equal(normalBalance(cls), "credit");
    }
  });
});

describe("parseGLReport — which side a movement lands on", () => {
  // 100 in, 40 out.
  const movements = [100, -40];

  it("reads a rise on an asset account as a debit", () => {
    // A bank account taking in 100 and paying out 40 has debits of 100, not
    // credits of 100. Reading the sign as the side directly gets this backwards
    // on every asset and expense account in the chart.
    const s = parseGLReport(gl("500.00", movements), "Asset");
    assert.equal(s.totalDebits, 100);
    assert.equal(s.totalCredits, 40);
  });

  it("reads a rise on an expense account as a debit", () => {
    const s = parseGLReport(gl("0.00", movements), "Expense");
    assert.equal(s.totalDebits, 100);
    assert.equal(s.totalCredits, 40);
  });

  it("reads a rise on a liability account as a credit", () => {
    const s = parseGLReport(gl("500.00", movements), "Liability");
    assert.equal(s.totalCredits, 100);
    assert.equal(s.totalDebits, 40);
  });

  it("reads a rise on a revenue account as a credit", () => {
    const s = parseGLReport(gl("0.00", movements), "Revenue");
    assert.equal(s.totalCredits, 100);
    assert.equal(s.totalDebits, 40);
  });
});

describe("parseGLReport — arithmetic that must not move", () => {
  it("keeps net activity as the signed balance movement whatever the side", () => {
    // Net is what closing balance is built from, so it has to mean the same
    // thing for an asset as for a liability.
    for (const cls of ["Asset", "Expense", "Liability", "Revenue"]) {
      assert.equal(parseGLReport(gl("500.00", [100, -40]), cls).netActivity, 60);
    }
  });

  it("derives closing from opening plus that movement", () => {
    const s = parseGLReport(gl("500.00", [100, -40]), "Asset");
    assert.equal(s.openingBalance, 500);
    assert.equal(s.closingBalance, 560);
  });

  it("sums opening balances across the sections of a rollup", () => {
    const rollup = gl("500.00", [100]);
    rollup.Rows.Row.push(JSON.parse(JSON.stringify(rollup.Rows.Row[0])));
    const s = parseGLReport(rollup, "Asset");
    assert.equal(s.openingBalance, 1000);
    assert.equal(s.transactionCount, 2);
  });

  it("counts transactions but not the beginning-balance row", () => {
    assert.equal(parseGLReport(gl("500.00", [100, -40, 7]), "Asset").transactionCount, 3);
  });

  it("ignores a zero-amount row", () => {
    assert.equal(parseGLReport(gl("0.00", [100, 0, -40]), "Asset").transactionCount, 2);
  });
});
