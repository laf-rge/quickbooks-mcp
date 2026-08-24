// The QuickBooks reports reachable through `get_report`.
//
// node-quickbooks declares 29 `report*` methods. Three of them — BalanceSheet,
// ProfitAndLoss and TrialBalance — already have dedicated tools whose rendering
// knows the shape of that particular report (section ordering, the trial
// balance's debit/credit columns, its close-review flags). Offering them here
// as well would give the model two ways to ask the same question, one of them
// strictly worse, so they are deliberately absent from this catalog.
//
// Two more are absent because they do not work: on a US company both
// TrialBalanceFR (a French regulatory variant) and TaxSummary answer HTTP 400.
// Listing a name that can only fail costs the caller a round trip to find out.
//
// That leaves the 24 below. `method` is the node-quickbooks function; `label` is
// what the renderer prints when the payload carries no ReportName of its own.

// Spelled out rather than derived from `keyof QuickBooks`: the class carries an
// index signature for dynamic finder access, which swallows a template-literal
// key and hands back `unknown` at the call site. A literal union indexes the
// declared methods instead, so a typo here is a compile error and the dispatch
// in the handler needs no cast.
export type ReportMethod =
  | "reportAccountListDetail"
  | "reportAgedPayableDetail"
  | "reportAgedPayables"
  | "reportAgedReceivableDetail"
  | "reportAgedReceivables"
  | "reportCashFlow"
  | "reportClassSales"
  | "reportCustomerBalance"
  | "reportCustomerBalanceDetail"
  | "reportCustomerIncome"
  | "reportCustomerSales"
  | "reportDepartmentSales"
  | "reportGeneralLedgerDetail"
  | "reportInventoryValuationSummary"
  | "reportItemSales"
  | "reportJournalReport"
  | "reportProfitAndLossDetail"
  | "reportTransactionList"
  | "reportTransactionListByCustomer"
  | "reportTransactionListByVendor"
  | "reportTransactionListWithSplits"
  | "reportVendorBalance"
  | "reportVendorBalanceDetail"
  | "reportVendorExpenses";

export interface ReportSpec {
  method: ReportMethod;
  label: string;
  /** Dated by a single point in time (`report_date`) rather than a range. */
  pointInTime?: boolean;
}

export const REPORT_CATALOG: Record<string, ReportSpec> = {
  aged_payables: { method: "reportAgedPayables", label: "Aged Payables", pointInTime: true },
  aged_payable_detail: { method: "reportAgedPayableDetail", label: "Aged Payable Detail", pointInTime: true },
  aged_receivables: { method: "reportAgedReceivables", label: "Aged Receivables", pointInTime: true },
  aged_receivable_detail: { method: "reportAgedReceivableDetail", label: "Aged Receivable Detail", pointInTime: true },
  account_list: { method: "reportAccountListDetail", label: "Account List" },
  cash_flow: { method: "reportCashFlow", label: "Statement of Cash Flows" },
  class_sales: { method: "reportClassSales", label: "Sales by Class" },
  customer_balance: { method: "reportCustomerBalance", label: "Customer Balance Summary", pointInTime: true },
  customer_balance_detail: { method: "reportCustomerBalanceDetail", label: "Customer Balance Detail", pointInTime: true },
  customer_income: { method: "reportCustomerIncome", label: "Income by Customer Summary" },
  customer_sales: { method: "reportCustomerSales", label: "Sales by Customer Summary" },
  department_sales: { method: "reportDepartmentSales", label: "Sales by Department" },
  general_ledger: { method: "reportGeneralLedgerDetail", label: "General Ledger" },
  inventory_valuation_summary: { method: "reportInventoryValuationSummary", label: "Inventory Valuation Summary", pointInTime: true },
  item_sales: { method: "reportItemSales", label: "Sales by Product/Service" },
  journal: { method: "reportJournalReport", label: "Journal" },
  profit_and_loss_detail: { method: "reportProfitAndLossDetail", label: "Profit and Loss Detail" },
  transaction_list: { method: "reportTransactionList", label: "Transaction List" },
  transaction_list_by_customer: { method: "reportTransactionListByCustomer", label: "Transaction List by Customer" },
  transaction_list_by_vendor: { method: "reportTransactionListByVendor", label: "Transaction List by Vendor" },
  transaction_list_with_splits: { method: "reportTransactionListWithSplits", label: "Transaction List with Splits" },
  vendor_balance: { method: "reportVendorBalance", label: "Vendor Balance Summary", pointInTime: true },
  vendor_balance_detail: { method: "reportVendorBalanceDetail", label: "Vendor Balance Detail", pointInTime: true },
  vendor_expenses: { method: "reportVendorExpenses", label: "Expenses by Vendor Summary" },
};

export const REPORT_NAMES = Object.keys(REPORT_CATALOG).sort();

/**
 * Accept the catalog key, and also QBO's own spelling of the report name
 * (`AgedPayables`, `aged payables`), which is what a caller reading Intuit's
 * docs will reach for. Everything is compared with separators and case removed,
 * so the two spellings collapse onto the same key.
 */
const BY_NORMALIZED = new Map<string, string>();
for (const name of REPORT_NAMES) {
  BY_NORMALIZED.set(name.replace(/_/g, ""), name);
  BY_NORMALIZED.set(REPORT_CATALOG[name].method.slice("report".length).toLowerCase(), name);
}

export function resolveReportName(input: string): string | undefined {
  return BY_NORMALIZED.get(input.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
}

/**
 * The three reports deliberately absent from the catalog, and the tool to use
 * instead. Named explicitly so a caller asking for one is sent straight to the
 * right tool: a nearest-name suggestion answers `vendor_balance` for
 * `trial_balance`, which is a different report the caller may well go on to run.
 */
const DEDICATED_TOOLS: Record<string, string> = {
  profitandloss: "get_profit_loss",
  balancesheet: "get_balance_sheet",
  trialbalance: "get_trial_balance",
};

export function dedicatedToolFor(input: string): string | undefined {
  return DEDICATED_TOOLS[input.trim().toLowerCase().replace(/[^a-z0-9]/g, "")];
}
