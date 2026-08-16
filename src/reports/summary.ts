// Report summary extraction utilities

import { QBReport, QBReportRow, QBReportColData } from "../types/index.js";

export interface ReportSummaryOptions {
  // Render individual account rows beneath each section total. Off by default so
  // the compact section summary stays the default output for every report.
  detail?: boolean;
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

function labelOf(cols: QBReportColData[] | undefined): string {
  return cols?.[0]?.value?.trim() || "";
}

// A report summarized by department/class has one column per member plus a
// trailing total; a plain report has a single value column. Either way the
// rightmost column is the one worth showing on a single line.
function pickValue(cols: QBReportColData[] | undefined, multiColumn: boolean): string | null {
  const values = (cols ?? []).slice(1).map(c => c.value || "0");
  if (values.length === 0) return null;
  return multiColumn ? values[values.length - 1] : values[0];
}

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

    // Leaf: an account row carries its name and value in ColData.
    const name = labelOf(row.ColData);
    const value = pickValue(row.ColData, multiColumn);
    if (name && value !== null) out.push(`${pad}${name}: ${value}`);
  }
}

// Trial Balance has no Section grouping — every account is a bare ColData row of
// [account, debit, credit], closed by a single GrandTotal section. The
// section-based path finds nothing here, which is why it rendered no numbers.
function renderTrialBalance(rows: QBReportRow[], out: string[]): void {
  const entries: Array<{ name: string; debit: string; credit: string }> = [];
  let total: QBReportColData[] | undefined;

  for (const row of rows) {
    if (row.group === "GrandTotal" || row.type === "Section") {
      total = row.Summary?.ColData;
      continue;
    }
    const name = labelOf(row.ColData);
    if (!name) continue;
    entries.push({
      name,
      debit: row.ColData?.[1]?.value || "",
      credit: row.ColData?.[2]?.value || "",
    });
  }

  if (entries.length === 0) return;

  // Cap the name column: a couple of deeply-nested sub-account names would
  // otherwise pad every row out to their width.
  const NAME_WIDTH_CAP = 60;
  const nameWidth = Math.min(Math.max(...entries.map(e => e.name.length)), NAME_WIDTH_CAP);
  const amountWidth = Math.max(
    ...entries.flatMap(e => [e.debit.length, e.credit.length]),
    6
  );
  const line = (name: string, debit: string, credit: string) =>
    `${name.padEnd(nameWidth)}  ${debit.padStart(amountWidth)}  ${credit.padStart(amountWidth)}`;

  out.push("");
  out.push(line("Account", "Debit", "Credit"));
  for (const e of entries) out.push(line(e.name, e.debit, e.credit));

  if (total) {
    out.push(line("TOTAL", total[1]?.value || "", total[2]?.value || ""));
  }
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

  // Column headers (departments if summarized)
  // filter(Boolean) already drops the leading label column, which has no title —
  // slicing again on top of it used to hide the first department from this list.
  const colTitles = columns.map(c => c.ColTitle).filter(Boolean);
  const multiColumn = colTitles.length > 2;
  if (multiColumn) {
    lines.push(`Columns: ${colTitles.join(", ")}`);
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
