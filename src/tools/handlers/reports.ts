// Handlers for report tools (profit_loss, balance_sheet, trial_balance)

import QuickBooks from "node-quickbooks";
import { getAccountCache, promisify, resolveDepartmentId, withRetry } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";
import {
  analyzeTrialBalance,
  extractReportSummary,
  parseTrialBalance,
  renderTrialBalanceFlags,
} from "../../reports/index.js";
import { QBReport } from "../../types/index.js";

export async function handleGetProfitLoss(
  client: QuickBooks,
  args: {
    start_date?: string;
    end_date?: string;
    summarize_by?: string;
    department?: string;
    accounting_method?: string;
    detail_level?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { start_date, end_date, summarize_by, department, accounting_method, detail_level } = args;

  const options: Record<string, string> = {};
  if (start_date) options.start_date = start_date;
  if (end_date) options.end_date = end_date;
  if (summarize_by) options.summarize_column_by = summarize_by;
  if (department) options.department = await resolveDepartmentId(client, department);
  if (accounting_method) options.accounting_method = accounting_method;

  const result = await withRetry(() =>
    promisify<unknown>((cb) => client.reportProfitAndLoss(options, cb))
  ) as QBReport;

  const summary = extractReportSummary(result, "Profit and Loss", { detail: detail_level === "account" });
  return outputReport("profit-loss", result, summary);
}

export async function handleGetBalanceSheet(
  client: QuickBooks,
  args: {
    as_of_date?: string;
    summarize_by?: string;
    department?: string;
    accounting_method?: string;
    detail_level?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { as_of_date, summarize_by, department, accounting_method, detail_level } = args;

  const options: Record<string, string> = {};
  if (as_of_date) {
    // Balance sheet needs both start_date and end_date
    // Set start_date to beginning of time for point-in-time report
    options.start_date = "1970-01-01";
    options.end_date = as_of_date;
  }
  if (summarize_by) options.summarize_column_by = summarize_by;
  if (department) options.department = await resolveDepartmentId(client, department);
  if (accounting_method) options.accounting_method = accounting_method;

  const result = await withRetry(() =>
    promisify<unknown>((cb) => client.reportBalanceSheet(options, cb))
  ) as QBReport;

  const summary = extractReportSummary(result, "Balance Sheet", { detail: detail_level === "account" });
  return outputReport("balance-sheet", result, summary);
}

export async function handleGetTrialBalance(
  client: QuickBooks,
  args: {
    start_date?: string;
    end_date?: string;
    accounting_method?: string;
    flags?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { start_date, end_date, accounting_method, flags } = args;

  const options: Record<string, string> = {};
  if (start_date) options.start_date = start_date;
  if (end_date) options.end_date = end_date;
  if (accounting_method) options.accounting_method = accounting_method;

  const result = await withRetry(() =>
    promisify<unknown>((cb) => client.reportTrialBalance(options, cb))
  ) as QBReport;

  const lines = [extractReportSummary(result, "Trial Balance")];

  // Opt-in: the flag pass costs an account-cache fetch and a block of output, so
  // the default response stays exactly what it was.
  if (flags) {
    const cache = await getAccountCache(client);
    const { entries } = parseTrialBalance(result.Rows?.Row || []);
    const flagLines: string[] = [];
    renderTrialBalanceFlags(analyzeTrialBalance(entries, cache.byId, cache.byAcctNum), flagLines);
    lines.push(flagLines.join("\n"));
  }

  return outputReport("trial-balance", result, lines.join("\n"));
}
