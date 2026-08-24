import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderGenericReport } from "../../src/reports/generic.js";
import type { QBReport } from "../../src/types/index.js";

// --- fixtures ---------------------------------------------------------------

function cols(...titles: string[]) {
  return { Column: titles.map(t => ({ ColTitle: t })) };
}

function data(...values: string[]) {
  return { ColData: values.map(v => ({ value: v })) };
}

// An aging report: flat rows under bucket columns, closed by a GrandTotal
// section that carries its figures in Summary and has no children.
const AGING: QBReport = {
  Header: { ReportName: "AgedPayables", EndPeriod: "2026-06-30" },
  Columns: cols("", "Current", "1 - 30", "31 - 60", "Total"),
  Rows: {
    Row: [
      data("North Supply", "100.00", "0.00", "0.00", "100.00"),
      data("South Supply", "0.00", "50.00", "25.00", "75.00"),
      {
        type: "Section",
        group: "GrandTotal",
        Summary: { ColData: [{ value: "TOTAL" }, { value: "100.00" }, { value: "50.00" }, { value: "25.00" }, { value: "175.00" }] },
      },
    ],
  },
} as QBReport;

// A sectioned report with one leaf under a section, plus a section subtotal.
const SECTIONED: QBReport = {
  Header: { ReportName: "CashFlow", StartPeriod: "2026-06-01", EndPeriod: "2026-06-30" },
  Columns: cols("", "Total"),
  Rows: {
    Row: [
      {
        type: "Section",
        group: "OperatingActivities",
        Header: { ColData: [{ value: "Operating Activities" }] },
        Rows: { Row: [data("Net Income", "500.00")] },
        Summary: { ColData: [{ value: "Net cash from operating" }, { value: "500.00" }] },
      },
    ],
  },
} as QBReport;

function lines(report: QBReport, options = {}) {
  return renderGenericReport(report, options).split("\n");
}

// The table header is the line after the blank separator.
function tableHeader(out: string[]): string {
  const blank = out.indexOf("");
  assert.notEqual(blank, -1, "expected a blank line before the table");
  return out[blank + 1];
}

// Columns are right-aligned, so a value belongs to a heading when the two end at
// the same offset.
function endOf(line: string, token: string): number {
  const at = line.indexOf(token);
  assert.notEqual(at, -1, `expected "${token}" in: ${line}`);
  return at + token.length;
}

describe("renderGenericReport — a report with no sections", () => {
  it("labels the columns the way the report does, not as debit and credit", () => {
    const out = lines(AGING);
    const header = tableHeader(out);
    // The regression this renderer exists for: a flat report used to reach the
    // trial balance renderer, which titles the first two value columns Debit
    // and Credit whatever they actually hold.
    assert.match(header, /Current/);
    assert.match(header, /1 - 30/);
    assert.match(header, /Total/);
    assert.doesNotMatch(header, /Debit|Credit/);
  });

  it("keeps every bucket, not just the trailing total", () => {
    const row = lines(AGING).find(l => l.startsWith("North Supply"))!;
    assert.match(row, /100\.00/);
    // Four value columns in, four value columns out.
    assert.equal(row.trim().split(/\s{2,}/).length, 5);
  });

  it("puts each value under its own heading", () => {
    const out = lines(AGING);
    const header = tableHeader(out);
    const row = out.find(l => l.startsWith("South Supply"))!;
    assert.equal(endOf(row, "50.00"), endOf(header, "1 - 30"));
    assert.equal(endOf(row, "25.00"), endOf(header, "31 - 60"));
  });

  it("renders a childless total section from its summary", () => {
    assert.ok(lines(AGING).some(l => l.startsWith("TOTAL") && l.includes("175.00")));
  });

  it("reports the period as an as-of date when there is only an end", () => {
    assert.ok(lines(AGING).includes("As of: 2026-06-30"));
  });
});

describe("renderGenericReport — sections", () => {
  it("prints the section header and its subtotal at summary level", () => {
    const out = lines(SECTIONED);
    assert.ok(out.some(l => l.startsWith("Operating Activities")));
    assert.ok(out.some(l => l.includes("Net cash from operating") && l.includes("500.00")));
  });

  it("withholds nested leaf rows at summary level", () => {
    assert.ok(!lines(SECTIONED).some(l => l.includes("Net Income")));
  });

  it("prints them at full detail, indented under the section", () => {
    const out = lines(SECTIONED, { detail: "full" });
    const leaf = out.find(l => l.includes("Net Income"));
    assert.ok(leaf, "expected the nested leaf at full detail");
    assert.ok(leaf!.startsWith("  "), "expected the leaf indented beneath its section");
  });

  it("keeps top-level rows at summary level, so a flat report is complete", () => {
    assert.ok(lines(AGING).some(l => l.startsWith("North Supply")));
  });
});

describe("renderGenericReport — cells that do not fit a table", () => {
  it("flattens a value containing newlines onto its own line", () => {
    // QBO returns memo and description text with the newlines the user typed.
    // Left alone, one such cell splits its row and every later value lands under
    // the wrong heading — and the row cap stops bounding the output.
    const report = {
      Header: { ReportName: "TransactionList" },
      Columns: cols("Date", "Memo", "Amount"),
      Rows: { Row: [data("2026-06-01", "first line\nsecond line\nthird", "10.00")] },
    } as QBReport;

    const out = lines(report);
    assert.equal(out.filter(l => l.includes("first line")).length, 1);
    const row = out.find(l => l.includes("first line"))!;
    assert.match(row, /first line second line third/);
    assert.match(row, /10\.00$/);
  });

  it("truncates a value too wide to size a column by", () => {
    const report = {
      Header: { ReportName: "TransactionList" },
      Columns: cols("Date", "Memo", "Amount"),
      Rows: { Row: [data("2026-06-01", "x".repeat(500), "10.00")] },
    } as QBReport;

    const row = lines(report).find(l => l.includes("x"))!;
    assert.ok(row.length < 120, `row is ${row.length} chars: one memo should not size the table`);
    assert.match(row, /…/);
  });
});

describe("renderGenericReport — size", () => {
  const many = {
    Header: { ReportName: "Journal" },
    Columns: cols("", "Amount"),
    Rows: { Row: Array.from({ length: 50 }, (_, i) => data(`Row ${i}`, "1.00")) },
  } as QBReport;

  it("caps the table and says how much it withheld", () => {
    const out = lines(many, { maxRows: 10 });
    assert.equal(out.filter(l => l.startsWith("Row ")).length, 10);
    const notice = out.find(l => l.startsWith("Showing "));
    assert.ok(notice, "expected a truncation notice");
    assert.match(notice!, /Showing 10 of 50 rows/);
    // A cap with no way past it is a dead end for an HTTP caller.
    assert.match(notice!, /max_rows/);
  });

  it("says nothing about truncation when nothing was truncated", () => {
    assert.ok(!lines(many, { maxRows: 50 }).some(l => l.startsWith("Showing ")));
  });

  it("reports an empty report as empty rather than as a bare title", () => {
    const empty = {
      Header: { ReportName: "AgedReceivableDetail" },
      Columns: cols("", "Amount"),
      Rows: { Row: [] },
    } as QBReport;
    assert.ok(lines(empty).includes("No rows."));
  });

  it("falls back to the catalog label when the payload has no report name", () => {
    const untitled = { Columns: cols("", "Amount"), Rows: { Row: [] } } as QBReport;
    assert.equal(lines(untitled, { label: "Aged Payables" })[0], "Aged Payables");
  });
});

describe("renderGenericReport — a payload that declares fewer columns than it fills", () => {
  // Nothing in the report payload guarantees one declared column per cell —
  // sales-by-item declares two and fills eight. Sizing the table by the header
  // list alone drops every value past the last declared column.
  const underDeclared = {
    Header: { ReportName: "CustomerBalance" },
    Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Total" }] },
    Rows: {
      Row: [
        { ColData: [{ value: "North Customer" }, { value: "100.00" }, { value: "25.00" }] },
      ],
    },
  } as unknown as QBReport;

  it("keeps a value that has no column to sit under", () => {
    const row = lines(underDeclared).find(l => l.startsWith("North Customer"))!;
    assert.match(row, /100\.00/);
    assert.match(row, /25\.00/);
  });

  it("does not open the table with a blank line when there is nothing to head it", () => {
    const bare = {
      Header: { ReportName: "CustomerBalance" },
      Columns: { Column: [{ ColTitle: "" }] },
      Rows: { Row: [{ ColData: [{ value: "TOTAL" }] }] },
    } as unknown as QBReport;
    const out = lines(bare);
    const blank = out.indexOf("");
    assert.equal(out[blank + 1], "TOTAL");
  });
});
