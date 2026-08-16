// QuickBooks report and transaction types

// Common QuickBooks reference type
export interface QBRef {
  value: string;
  name?: string;
}

// QuickBooks API error structure
// QB API returns capitalized Fault.Error, but node-quickbooks may use lowercase
export interface QBError {
  Fault?: {
    Error?: Array<{ code?: string; Code?: string; message?: string; Message?: string; Detail?: string; detail?: string }>;
  };
  fault?: {
    error?: Array<{ code?: string; Code?: string; message?: string; Message?: string; Detail?: string; detail?: string }>;
  };
}

// Type guard for QB error objects (handles both casings)
export function isQBError(error: unknown): error is QBError {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as Record<string, unknown>;
  // Check capitalized (actual QB API)
  if (err.Fault && typeof err.Fault === 'object') {
    const fault = err.Fault as Record<string, unknown>;
    if (Array.isArray(fault.Error)) return true;
  }
  // Check lowercase (node-quickbooks legacy)
  if (err.fault && typeof err.fault === 'object') {
    const fault = err.fault as Record<string, unknown>;
    if (Array.isArray(fault.error)) return true;
  }
  return false;
}

// Extract normalized error info from a QB error (casing-safe)
export function extractQBErrorInfo(error: QBError): { code?: string; message?: string; detail?: string } {
  const errors = error.Fault?.Error ?? error.fault?.error;
  if (!errors || errors.length === 0) return {};
  const first = errors[0];
  return {
    code: first.Code ?? first.code,
    message: first.Message ?? first.message,
    detail: first.Detail ?? first.detail,
  };
}

// QuickBooks entity base
export interface QBEntity {
  Id: string;
  SyncToken?: string;
  TxnDate?: string;
  DocNumber?: string;
  PrivateNote?: string;
  TotalAmt?: number;
  Line?: QBLine[];
}

// Line item types
export interface QBLine {
  Id: string;
  Amount: number;
  Description?: string;
  DetailType: string;
  JournalEntryLineDetail?: {
    PostingType: string;
    AccountRef: QBRef;
    DepartmentRef?: QBRef;
  };
  AccountBasedExpenseLineDetail?: {
    AccountRef: QBRef;
    DepartmentRef?: QBRef;
  };
  DepositLineDetail?: {
    AccountRef?: QBRef;
    DepartmentRef?: QBRef;
  };
  SalesItemLineDetail?: {
    ItemRef?: QBRef;
    Qty?: number;
    UnitPrice?: number;
  };
  ItemBasedExpenseLineDetail?: {
    ItemRef: QBRef;
    Qty?: number;
    UnitPrice?: number;
  };
}

// Journal Entry specific
export interface QBJournalEntry extends QBEntity {
  Line: Array<QBLine & {
    JournalEntryLineDetail: {
      PostingType: string;
      AccountRef: QBRef;
      DepartmentRef?: QBRef;
    };
  }>;
}

// Purchase/Expense specific
export interface QBPurchase extends QBEntity {
  PaymentType: string;
  AccountRef?: QBRef;
  EntityRef?: QBRef & { type?: string };
}

// Bill specific
export interface QBBill extends QBEntity {
  DueDate?: string;
  VendorRef: QBRef;
  APAccountRef?: QBRef;
}

// Deposit specific
export interface QBDeposit extends QBEntity {
  DepositToAccountRef?: QBRef;
}

// Sales Receipt specific
export interface QBSalesReceipt extends QBEntity {
  DepositToAccountRef?: QBRef;
  DepartmentRef?: QBRef;
}

// Payment specific
export interface QBPayment extends QBEntity {
  DepositToAccountRef?: QBRef;
}

// Query response wrapper
export interface QBQueryResponse<T = unknown> {
  QueryResponse?: {
    [key: string]: T[];
  };
}

export interface QBReportColData {
  value?: string;
  id?: string;
}

// QBO report rows nest arbitrarily deep: a Section carries a Header, child Rows
// and a Summary, while a leaf row carries ColData directly. Trial Balance is the
// odd one out — its account rows are bare ColData with no type or group at all.
export interface QBReportRow {
  type?: string;
  group?: string;
  Header?: { ColData?: QBReportColData[] };
  Summary?: { ColData?: QBReportColData[] };
  ColData?: QBReportColData[];
  Rows?: { Row?: QBReportRow[] };
}

export interface QBReport {
  Header?: {
    ReportName?: string;
    StartPeriod?: string;
    EndPeriod?: string;
    DateMacro?: string;
    ReportBasis?: string;
    Currency?: string;
    Option?: Array<{ Name: string; Value: string }>;
  };
  Columns?: {
    Column?: Array<{ ColTitle?: string; ColType?: string }>;
  };
  Rows?: {
    Row?: QBReportRow[];
  };
}

export interface TransactionLine {
  date: string;
  type: string;
  txnId: string;
  docNumber?: string;
  lineId: string;
  amount: number;        // Positive = debit, Negative = credit
  description?: string;
  department?: string;
  qboLink: string;
  accountId: string;           // Account ID for this line
  accountName: string;         // Account name (e.g., "4010 Sales" or "Undeposited Funds")
  isMatchingLine: boolean;     // True if this line matched the target account query
}
