// Report summary extraction utilities

import { QBReport, QBReportRow } from "../types/index.js";
import { allValues, labelOf, pickValue } from "./rows.js";
import { elideAccountName, renderTrialBalance } from "./trial-balance.js";

export interface ReportSummaryOptions {
  // Render individual account rows beneath each section total. Off by default so
  // the compact section summary stays the default output for every report.
  detail?: boolean;
  // Render every column rather than only the trailing total. Meaningful on a
  // report summarized by department/class/month; on a single-column report there
  // is nothing extra to show and it is ignored. Without it the per-member values
  // appear nowhere in the rendered output, only in the raw payload.
  allColumns?: boolean;
}

// Labels share the line with one column per member in all-columns mode, so they
// get a tighter budget than the two-column trial balance.
const TABLE_LABEL_CAP = 45;

// A row of the all-columns table. A section header carries no values.
interface TableRow {
  indent: number;
  label: string;
  values: string[];
}

// Section groups in the order QBO reports them. OtherExpenses/NetOtherIncome sit
// between operating income and net income; omitting them used to leave an
// unexplained gap between "Net Operating Income" and "Net Income".
const PL_GROUP_ORDER = [
  "Income",
  "COGS",
  "GrossProfit",
  "Expenses",
  "NetOperatingIncome",
  "OtherIncome",
  "OtherExpenses",
  "NetOtherIncome",
  "NetIncome",
];

const BALANCE_SHEET_GROUP_ORDER = ["TotalAssets", "TotalLiabilitiesAndEquity"];

const GROUP_LABELS: Record<string, string> = {
  Income: "Total Income",
  COGS: "Total Cost of Goods Sold",
  GrossProfit: "Gross Profit",
  Expenses: "Total Expenses",
  NetOperatingIncome: "Net Operating Income",
  OtherIncome: "Total Other Income",
  OtherExpenses: "Total Other Expenses",
  NetOtherIncome: "Net Other Income",
  NetIncome: "Net Income",
  TotalAssets: "Total Assets",
  TotalLiabilitiesAndEquity: "Total Liabilities and Equity",
};

// Walk a section's children, emitting leaf account rows and nested subtotals.
function renderDetail(
  rows: QBReportRow[],
  multiColumn: boolean,
  depth: number,
  out: string[]
): void {
  const pad = "  ".repeat(depth);
  for (const row of rows) {
    const nested = row.Rows?.Row;
    if (nested && nested.length > 0) {
      const header = labelOf(row.Header?.ColData);
      if (header) out.push(`${pad}${header}`);
      renderDetail(nested, multiColumn, depth + 1, out);
      const subtotal = pickValue(row.Summary?.ColData, multiColumn);
      const subtotalLabel = labelOf(row.Summary?.ColData);
      if (subtotal !== null && subtotalLabel) {
        out.push(`${pad}  ${subtotalLabel}: ${subtotal}`);
      }
      continue;
    }

    // Leaf: an account row carries its name and value in ColData. A row with no
    // value cell at all still gets listed — dropping it would silently remove an
    // account from a report whose purpose is completeness.
    const name = labelOf(row.ColData);
    if (name) out.push(`${pad}${name}: ${pickValue(row.ColData, multiColumn) ?? "0"}`);
  }
}

// Same walk as renderDetail, but keeping every column instead of collapsing to
// the trailing total.
function collectDetail(rows: QBReportRow[], depth: number, out: TableRow[]): void {
  for (const row of rows) {
    const nested = row.Rows?.Row;
    if (nested && nested.length > 0) {
      const header = labelOf(row.Header?.ColData);
      if (header) out.push({ indent: depth, label: header, values: [] });
      collectDetail(nested, depth + 1, out);
      const subtotalLabel = labelOf(row.Summary?.ColData);
      if (subtotalLabel) {
        out.push({ indent: depth + 1, label: subtotalLabel, values: allValues(row.Summary?.ColData) });
      }
      continue;
    }
    const name = labelOf(row.ColData);
    if (name) out.push({ indent: depth, label: name, values: allValues(row.ColData) });
  }
}

function renderTable(rows: TableRow[], colTitles: string[], out: string[]): void {
  if (rows.length === 0) return;

  const labels = rows.map(r => elideAccountName("  ".repeat(r.indent) + r.label, TABLE_LABEL_CAP));
  const labelWidth = Math.max(...labels.map(l => l.length));

  // Width per column rather than one global max: a single wide heading such as
  // "Not Specified" would otherwise pad every numeric column out to its length,
  // which on a detail P&L is most of the table's bytes.
  const widths = colTitles.map((title, i) =>
    Math.max(title.length, ...rows.map(r => (r.values[i] ?? "").length))
  );

  const format = (label: string, values: string[]) =>
    `${label.padEnd(labelWidth)}  ${widths
      .map((w, i) => (values[i] ?? "").padStart(w))
      .join("  ")}`.trimEnd();

  out.push("");
  out.push(format("", colTitles));
  rows.forEach((r, i) => out.push(format(labels[i], r.values)));
}

export function extractReportSummary(
  report: QBReport,
  reportType: string,
  options: ReportSummaryOptions = {}
): string {
  const header = report.Header || {};
  const columns = report.Columns?.Column || [];
  const rows = report.Rows?.Row || [];

  const lines: string[] = [];

  // Report title and period
  lines.push(`${header.ReportName || reportType}`);
  if (header.StartPeriod && header.EndPeriod) {
    lines.push(`Period: ${header.StartPeriod} to ${header.EndPeriod}`);
  } else if (header.EndPeriod) {
    lines.push(`As of: ${header.EndPeriod}`);
  }
  if (header.ReportBasis) {
    lines.push(`Basis: ${header.ReportBasis}`);
  }

  // Column headers (departments if summarized).
  //
  // Drop the leading label column positionally rather than by filtering on an
  // empty title: a titled first column would otherwise leak into the list.
  //
  // Keep every remaining column, including untitled ones. Row values are sliced
  // positionally, so index i of this list must stay index i of every row's
  // values — dropping an untitled column here would shift every later number one
  // column left and silently attribute it to the wrong department.
  const colTitles = columns.slice(1).map(c => c.ColTitle ?? "");
  const namedTitles = colTitles.filter(Boolean);
  const multiColumn = colTitles.length > 2;
  if (multiColumn && namedTitles.length > 0) {
    lines.push(`Columns: ${namedTitles.join(", ")}`);
  }

  // Trial Balance is a flat account listing, not a set of sections. Detect it by
  // shape rather than by name so a renamed report still renders.
  const hasSections = rows.some(r => r.type === "Section" && r.group !== "GrandTotal");
  if (!hasSections) {
    renderTrialBalance(rows, lines);
    return lines.join("\n");
  }

  const groupOrder = reportType.includes("Balance Sheet")
    ? BALANCE_SHEET_GROUP_ORDER
    : PL_GROUP_ORDER;

  // All-columns renders the whole report as one table so every row shares the
  // same column offsets. Gate on there being more than one value column rather
  // than on multiColumn: a report summarized down to a single member still has a
  // member column and a total column worth showing, and silently ignoring the
  // flag there would look like the option did nothing.
  if (options.allColumns && colTitles.length > 1) {
    const tableRows: TableRow[] = [];
    for (const groupName of groupOrder) {
      const row = rows.find(r => r.type === "Section" && r.group === groupName);
      if (!row) continue;

      if (options.detail && row.Rows?.Row?.length) {
        const sectionLabel = labelOf(row.Header?.ColData) || GROUP_LABELS[groupName] || groupName;
        tableRows.push({ indent: 0, label: sectionLabel, values: [] });
        collectDetail(row.Rows.Row, 1, tableRows);
      }

      const totals = allValues(row.Summary?.ColData);
      if (totals.length > 0) {
        tableRows.push({ indent: 0, label: GROUP_LABELS[groupName] || groupName, values: totals });
      }
    }
    renderTable(tableRows, colTitles, lines);
    return lines.join("\n");
  }

  for (const groupName of groupOrder) {
    const row = rows.find(r => r.type === "Section" && r.group === groupName);
    if (!row) continue;

    if (options.detail && row.Rows?.Row?.length) {
      lines.push("");
      const sectionLabel = labelOf(row.Header?.ColData) || GROUP_LABELS[groupName] || groupName;
      lines.push(sectionLabel);
      renderDetail(row.Rows.Row, multiColumn, 1, lines);
    }

    const value = pickValue(row.Summary?.ColData, multiColumn);
    if (value !== null) {
      const label = GROUP_LABELS[groupName] || groupName;
      lines.push(`${label}: ${value}`);
    }
  }

  return lines.join("\n");
}
