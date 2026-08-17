import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractReportSummary } from "../../src/reports/summary.js";
import type { QBReport } from "../../src/types/index.js";

// A P&L with one Income section holding a single account row, so the column
// handling is the only thing under test.
function report(titles: string[], values: string[]): QBReport {
  return {
    Header: { ReportName: "ProfitAndLoss" },
    Columns: { Column: [{ ColTitle: "" }, ...titles.map(t => ({ ColTitle: t }))] },
    Rows: {
      Row: [
        {
          type: "Section",
          group: "Income",
          Header: { ColData: [{ value: "Income" }] },
          Rows: {
            Row: [
              {
                type: "Data",
                ColData: [{ value: "4000 Sales" }, ...values.map(v => ({ value: v }))],
              },
            ],
          },
          Summary: { ColData: [{ value: "Total Income" }, ...values.map(v => ({ value: v }))] },
        },
      ],
    },
  } as QBReport;
}

// Columns are right-aligned, so a value belongs to a heading when the two end at
// the same offset.
// The table header is the line right after the blank separator — matching on a
// column title alone would also hit the "Columns:" line above it.
function tableHeader(lines: string[]): string {
  const blank = lines.indexOf("");
  assert.notEqual(blank, -1, "expected a blank line before the table");
  return lines[blank + 1];
}

function endOf(line: string, token: string): number {
  const at = line.indexOf(token);
  assert.notEqual(at, -1, `expected to find ${JSON.stringify(token)} in ${JSON.stringify(line)}`);
  return at + token.length;
}

describe("extractReportSummary — allColumns", () => {
  it("keeps an untitled value column in its own slot", () => {
    // QBO titling every non-leading column is an assumption, not a guarantee.
    // If an untitled column were dropped from the header list while values are
    // still sliced positionally, every later number would shift one column left
    // and be attributed to the wrong department.
    const out = extractReportSummary(
      report(["North", "", "South", "Total"], ["100.00", "200.00", "300.00", "600.00"]),
      "Profit and Loss",
      { allColumns: true, detail: true }
    ).split("\n");

    const header = tableHeader(out);
    const row = out.find(l => l.includes("4000 Sales"))!;

    assert.equal(endOf(header, "South"), endOf(row, "300.00"));
    assert.equal(endOf(header, "Total"), endOf(row, "600.00"));
    // Nothing may hang past the final heading.
    assert.ok(row.trimEnd().endsWith("600.00"));
  });

  it("lists only titled columns in the Columns: line", () => {
    const out = extractReportSummary(
      report(["North", "", "South", "Total"], ["1.00", "2.00", "3.00", "6.00"]),
      "Profit and Loss",
      { allColumns: true }
    );
    assert.ok(out.includes("Columns: North, South, Total"));
  });

  it("sizes each column independently", () => {
    // One wide heading must not pad the numeric columns out to its width.
    const out = extractReportSummary(
      report(["A", "Not Specified", "Total"], ["1.00", "2.00", "3.00"]),
      "Profit and Loss",
      { allColumns: true }
    ).split("\n");

    const header = tableHeader(out);
    const row = out.find(l => l.startsWith("Total Income"))!;

    // "A" holds a 4-char value, so its column is 4 wide, not 13.
    assert.equal(endOf(header, "A"), endOf(row, "1.00"));
    assert.equal(endOf(header, "Not Specified"), endOf(row, "2.00"));
    assert.equal(endOf(header, "Total"), endOf(row, "3.00"));
    // A global width would have made the row at least 3*13 wide.
    assert.ok(row.length < 45, `row unexpectedly wide: ${row.length}`);
  });

  it("renders a table when there is a member column and a total", () => {
    // Exactly two value columns: the flag must do something rather than
    // silently no-op.
    const r = report(["North", "Total"], ["100.00", "100.00"]);
    assert.notEqual(
      extractReportSummary(r, "Profit and Loss"),
      extractReportSummary(r, "Profit and Loss", { allColumns: true })
    );
  });

  it("is a no-op when there is only a total column", () => {
    const r = report(["Total"], ["100.00"]);
    assert.equal(
      extractReportSummary(r, "Profit and Loss"),
      extractReportSummary(r, "Profit and Loss", { allColumns: true })
    );
  });

  it("leaves default output untouched", () => {
    const r = report(["North", "South", "Total"], ["100.00", "200.00", "300.00"]);
    assert.equal(
      extractReportSummary(r, "Profit and Loss"),
      [
        "ProfitAndLoss",
        "Columns: North, South, Total",
        "Total Income: 300.00",
      ].join("\n")
    );
  });

  it("emits no trailing whitespace", () => {
    const out = extractReportSummary(
      report(["North", "Not Specified", "Total"], ["100.00", "", "100.00"]),
      "Profit and Loss",
      { allColumns: true, detail: true }
    );
    for (const line of out.split("\n")) {
      assert.equal(line, line.trimEnd(), `trailing whitespace: ${JSON.stringify(line)}`);
    }
  });
});
