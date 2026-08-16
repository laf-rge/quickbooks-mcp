// Report summary extraction utilities

import { QBReport, QBReportRow } from "../types/index.js";
import { labelOf, pickValue } from "./rows.js";
import { renderTrialBalance } from "./trial-balance.js";

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
  // Drop the leading label column positionally, then filter — relying on
  // filter(Boolean) to remove it only works while QBO leaves its title empty,
  // and a titled first column would otherwise leak into the department list.
  const colTitles = columns.slice(1).map(c => c.ColTitle).filter(Boolean);
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
