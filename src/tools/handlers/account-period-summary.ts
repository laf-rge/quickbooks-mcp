// Handler for account_period_summary tool
// Uses the GeneralLedger report to provide opening/closing balances,
// total debits/credits, and transaction count for any account over a date range.

import QuickBooks from "node-quickbooks";
import { resolveAccount, resolveDepartmentId, promisify } from "../../client/index.js";
import { outputReport, toCents, toDollars } from "../../utils/index.js";
import { QBReport } from "../../types/index.js";

interface GLRowColData {
  value?: string;
  id?: string;
}

interface GLRow {
  type?: string;
  group?: string;
  ColData?: GLRowColData[];
  Summary?: { ColData?: GLRowColData[] };
  Rows?: { Row?: GLRow[] };
  Header?: { ColData?: GLRowColData[] };
}

interface GLReport {
  Header?: QBReport["Header"];
  Columns?: {
    Column?: Array<{ ColTitle?: string; ColType?: string; MetaData?: Array<{ Name: string; Value: string }> }>;
  };
  Rows?: {
    Row?: GLRow[];
  };
}

interface PeriodSummary {
  openingBalance: number;
  closingBalance: number;
  totalDebits: number;
  totalCredits: number;
  netActivity: number;
  transactionCount: number;
}

/**
 * Parse a GeneralLedger report to extract period summary data.
 *
 * GL report structure (nested sections):
 *   Section (parent account) → Section (child account) → Data rows
 *
 * Columns: Date, Transaction Type, Num, Name, Memo/Description, Split, Amount, Balance
 * - "Amount" column: negative = debit, positive = credit
 * - "Balance" column: running balance, restarting at each section
 * - "Beginning Balance" row: Balance column has that section's opening balance
 * - Summary row: Amount column has net activity total; Balance column is empty
 *
 * A report for a parent account contains one section per account in the subtree,
 * each with its own Beginning Balance and its own running Balance. Opening
 * balances therefore sum across sections, but the running Balance column does
 * NOT — the last row of the report is only the last *section's* closing figure.
 * Closing is derived as opening + net activity, which is true per section and
 * per rollup, rather than read from that column.
 *
 * Amounts accumulate in integer cents (see src/utils/money.ts) so a few hundred
 * float additions cannot drift the totals.
 */
// Exported for verification: this is where the rollup arithmetic lives.
export function parseGLReport(report: GLReport): PeriodSummary {
  const columns = report.Columns?.Column ?? [];

  const amountIdx = columns.findIndex(c => c.ColTitle === "Amount");
  const balanceIdx = columns.findIndex(c => c.ColTitle === "Balance");

  let openingCents = 0;
  let totalDebitsCents = 0;
  let totalCreditsCents = 0;
  let transactionCount = 0;

  const rows = report.Rows?.Row ?? [];

  function processRows(rowList: GLRow[]): void {
    for (const row of rowList) {
      // Recurse into nested sections (parent account → child account)
      if (row.Rows?.Row) {
        processRows(row.Rows.Row);
      }

      // Process Data rows (Beginning Balance + transaction rows)
      if (row.type === "Data" && row.ColData) {
        const colData = row.ColData;
        const firstCol = colData[0]?.value ?? "";

        if (firstCol === "Beginning Balance") {
          // One per section; a rollup report has several, and they sum.
          if (balanceIdx >= 0 && colData[balanceIdx]?.value) {
            openingCents += toCents(parseFloat(colData[balanceIdx].value!) || 0);
          }
          continue;
        }

        // Transaction row
        const amount = amountIdx >= 0 && colData[amountIdx]?.value
          ? parseFloat(colData[amountIdx].value!) || 0
          : 0;

        if (amount !== 0) {
          transactionCount++;
          if (amount < 0) {
            totalDebitsCents += toCents(Math.abs(amount));
          } else {
            totalCreditsCents += toCents(amount);
          }
        }
      }
    }
  }

  processRows(rows);

  const netActivityCents = totalCreditsCents - totalDebitsCents;

  return {
    openingBalance: toDollars(openingCents),
    // Derived, not read from the Balance column: that column restarts per
    // section, so on a rollup its final value is just the last sub-account's.
    closingBalance: toDollars(openingCents + netActivityCents),
    totalDebits: toDollars(totalDebitsCents),
    totalCredits: toDollars(totalCreditsCents),
    netActivity: toDollars(netActivityCents),
    transactionCount,
  };
}

export async function handleAccountPeriodSummary(
  client: QuickBooks,
  args: {
    account: string;
    start_date?: string;
    end_date?: string;
    department?: string;
    accounting_method?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { account, start_date, end_date, department, accounting_method } = args;

  // Resolve account using cache
  const resolvedAccount = await resolveAccount(client, account);

  // Build report options
  const options: Record<string, string> = {
    account: resolvedAccount.Id,
  };

  const today = new Date().toISOString().split("T")[0];
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const startDateResolved = start_date || yearStart;
  const endDateResolved = end_date || today;

  options.start_date = startDateResolved;
  options.end_date = endDateResolved;

  if (department) {
    options.department = await resolveDepartmentId(client, department);
  }
  if (accounting_method) {
    options.accounting_method = accounting_method;
  }

  // Call the GeneralLedger report
  const report = (await promisify<unknown>((cb) =>
    client.reportGeneralLedgerDetail(options, cb)
  )) as GLReport;

  // Parse the report
  const summary = parseGLReport(report);

  // Build summary string
  const formatCurrency = (n: number) => {
    const sign = n < 0 ? "-" : "";
    return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const acctLabel = resolvedAccount.AcctNum
    ? `${resolvedAccount.AcctNum} ${resolvedAccount.FullyQualifiedName || resolvedAccount.Name}`
    : resolvedAccount.FullyQualifiedName || resolvedAccount.Name;

  const summaryLines = [
    "Account Period Summary",
    "======================",
    `Account: ${acctLabel} (${resolvedAccount.AccountType})`,
    `Period: ${startDateResolved} to ${endDateResolved}`,
  ];

  if (department) {
    summaryLines.push(`Department: ${department}`);
  }
  if (accounting_method) {
    summaryLines.push(`Basis: ${accounting_method}`);
  }

  summaryLines.push("");
  summaryLines.push(`Opening Balance:  ${formatCurrency(summary.openingBalance)}`);
  summaryLines.push(`Total Debits:     ${formatCurrency(summary.totalDebits)}`);
  summaryLines.push(`Total Credits:    ${formatCurrency(summary.totalCredits)}`);
  summaryLines.push(`Net Activity:     ${formatCurrency(summary.netActivity)}`);
  summaryLines.push(`Closing Balance:  ${formatCurrency(summary.closingBalance)}`);
  summaryLines.push(`Transactions:     ${summary.transactionCount}`);

  // Build report data
  const reportData = {
    account: {
      id: resolvedAccount.Id,
      acctNum: resolvedAccount.AcctNum,
      name: resolvedAccount.FullyQualifiedName || resolvedAccount.Name,
      type: resolvedAccount.AccountType,
    },
    dateRange: {
      start: startDateResolved,
      end: endDateResolved,
    },
    department: department || undefined,
    accountingMethod: accounting_method || "Accrual",
    summary,
  };

  return outputReport("account-period-summary", reportData, summaryLines.join("\n"));
}
