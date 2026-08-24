// Handler for get_report — the QuickBooks reports that have no tool of their own.

import QuickBooks from "node-quickbooks";
import {
  promisify,
  resolveCustomer,
  resolveDepartmentId,
  resolveVendor,
  withRetry,
} from "../../client/index.js";
import { outputReport } from "../../utils/index.js";
import {
  DEFAULT_MAX_ROWS,
  REPORT_CATALOG,
  REPORT_NAMES,
  renderGenericReport,
  resolveReportName,
} from "../../reports/index.js";
import { suggestClosest } from "../validate.js";
import { QBReport } from "../../types/index.js";

// Upper bound on the rendered table. Past this the response stops being a
// summary and becomes the report, at which point the payload is the better
// route (a file in stdio, include_raw over HTTP).
const MAX_ROWS_CEILING = 2000;

// node-quickbooks builds the report query string by concatenating keys and
// values verbatim — no encoding at all (`module.reportCriteria`). A value
// carrying `&` or `=` would therefore not be escaped but would instead add
// criteria of its own to the URL. Resolved ids and dates are already safe;
// this guards the free-text passthroughs so an odd value fails here, naming
// itself, rather than silently changing what was asked for.
const SAFE_CRITERION = /^[A-Za-z0-9_,:. -]+$/;

function criterion(name: string, value: string): string {
  if (!SAFE_CRITERION.test(value)) {
    throw new Error(
      `Invalid ${name} "${value}": report criteria may contain only letters, ` +
        `digits, spaces, and , : . _ - characters.`
    );
  }
  return value;
}

export async function handleGetReport(
  client: QuickBooks,
  args: {
    report?: string;
    start_date?: string;
    end_date?: string;
    report_date?: string;
    date_macro?: string;
    accounting_method?: string;
    summarize_by?: string;
    department?: string;
    customer?: string;
    vendor?: string;
    detail_level?: string;
    max_rows?: number;
    include_raw?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    report, start_date, end_date, report_date, date_macro, accounting_method,
    summarize_by, department, customer, vendor, detail_level,
    max_rows, include_raw = false,
  } = args;

  if (!report) {
    throw new Error(`Missing required parameter "report". One of: ${REPORT_NAMES.join(", ")}`);
  }

  // validateToolArguments deliberately leaves enums to the handler, so the
  // catalog is checked here — and a near miss gets the same suggestion
  // treatment a misspelled parameter name gets.
  const key = resolveReportName(report);
  if (!key) {
    const suggestion = suggestClosest(report, REPORT_NAMES);
    throw new Error(
      `Unknown report "${report}"${suggestion ? `. Did you mean "${suggestion}"?` : "."} ` +
        `Supported: ${REPORT_NAMES.join(", ")}. ` +
        `Profit and Loss, Balance Sheet and Trial Balance have dedicated tools ` +
        `(get_profit_loss, get_balance_sheet, get_trial_balance).`
    );
  }

  const spec = REPORT_CATALOG[key];
  const options: Record<string, string> = {};

  // A point-in-time report is dated by report_date; QBO ignores a range on it.
  // Accept end_date as report_date there so a caller who reaches for the range
  // parameter is not silently answered as of today.
  if (spec.pointInTime) {
    const asOf = report_date ?? end_date;
    if (asOf) options.report_date = criterion("report_date", asOf);
  } else {
    if (report_date) {
      throw new Error(
        `Report "${key}" covers a date range — use start_date and end_date, not report_date.`
      );
    }
    if (start_date) options.start_date = criterion("start_date", start_date);
    if (end_date) options.end_date = criterion("end_date", end_date);
  }

  if (date_macro) options.date_macro = criterion("date_macro", date_macro);
  if (accounting_method) options.accounting_method = criterion("accounting_method", accounting_method);
  if (summarize_by) options.summarize_column_by = criterion("summarize_by", summarize_by);
  if (department) options.department = await resolveDepartmentId(client, department);
  if (customer) options.customer = (await resolveCustomer(client, customer)).value;
  if (vendor) options.vendor = (await resolveVendor(client, vendor)).value;

  const result = (await withRetry(() =>
    promisify<unknown>((cb) => client[spec.method](options, cb))
  )) as QBReport;

  const summary = renderGenericReport(result, {
    label: spec.label,
    detail: detail_level === "full" ? "full" : "summary",
    maxRows: Math.min(max_rows ?? DEFAULT_MAX_ROWS, MAX_ROWS_CEILING),
  });

  return outputReport(`report-${key}`, result, summary, { includeRaw: include_raw });
}
