// Tool definitions for QuickBooks MCP server

export const toolDefinitions = [
  {
    name: "qbo_authenticate",
    description: "Authenticate with QuickBooks using OAuth (local credential mode only). " +
      "Step 1: Call with no arguments to get the authorization URL. " +
      "Step 2: After authorizing in browser, call with authorization_code and realm_id from the callback URL. " +
      "This tool only works when QBO_CREDENTIAL_MODE is 'local' (the default).",
    inputSchema: {
      type: "object",
      properties: {
        authorization_code: {
          type: "string",
          description: "Authorization code from the QuickBooks OAuth callback URL (the 'code' parameter)",
        },
        realm_id: {
          type: "string",
          description: "Company/realm ID from the callback URL (the 'realmId' parameter). Required when providing authorization_code.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_company_info",
    description: "Get information about the connected QuickBooks company.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "query",
    description: "Execute a QuickBooks query using SQL-like syntax. Supports querying any entity type (Customer, Vendor, Invoice, Bill, Account, Item, Department, etc.). Results are written to a file to preserve context. Defaults to MAXRESULTS 1000 if not specified. Examples: 'SELECT * FROM Customer', 'SELECT * FROM SalesReceipt WHERE TxnDate >= \\'2025-11-01\\' AND TxnDate <= \\'2025-11-30\\''",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The SQL-like query string, e.g. SELECT * FROM Bill WHERE TxnDate >= '2026-01-01'. Any queryable QBO entity works. Add MAXRESULTS N to limit results (default: 1000). Most transaction fields (DepartmentRef, AccountRef, Line) are not filterable; errors list the valid ones. Use query_account_transactions to filter by account or department.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_accounts",
    description: "List all accounts in the chart of accounts. Returns AcctNum (the user-facing account number), Name, AccountType, AccountSubType, and CurrentBalance. Use AcctNum to reference accounts in other queries or operations.",
    inputSchema: {
      type: "object",
      properties: {
        account_type: {
          type: "string",
          description: "Optional filter by account type (e.g., 'Bank', 'Expense', 'Income', 'Other Current Asset', 'Fixed Asset', 'Other Current Liability', 'Equity')",
        },
        active_only: {
          type: "boolean",
          description: "If true, only return active accounts (default: true)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_profit_loss",
    description: "Get a Profit and Loss (Income Statement) report. Can be broken down by department/location.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description: "Start date in YYYY-MM-DD format",
        },
        end_date: {
          type: "string",
          description: "End date in YYYY-MM-DD format",
        },
        summarize_by: {
          type: "string",
          description: "How to summarize columns: 'Total' (default), 'Month', 'Week', 'Days', 'Quarter', 'Year', 'Customers', 'Vendors', 'Classes', 'Departments', 'Employees', 'ProductsAndServices'",
        },
        department: {
          type: "string",
          description: "Filter to a specific department/location ID",
        },
        accounting_method: {
          type: "string",
          description: "Accounting method: 'Accrual' (default) or 'Cash'",
        },
      },
      required: [],
    },
  },
  {
    name: "get_balance_sheet",
    description: "Get a Balance Sheet report. Can be broken down by department/location.",
    inputSchema: {
      type: "object",
      properties: {
        as_of_date: {
          type: "string",
          description: "Report as of this date in YYYY-MM-DD format (defaults to today)",
        },
        summarize_by: {
          type: "string",
          description: "How to summarize columns: 'Total' (default), 'Month', 'Week', 'Days', 'Quarter', 'Year', 'Customers', 'Vendors', 'Classes', 'Departments', 'Employees', 'ProductsAndServices'",
        },
        department: {
          type: "string",
          description: "Filter to a specific department/location ID",
        },
        accounting_method: {
          type: "string",
          description: "Accounting method: 'Accrual' (default) or 'Cash'",
        },
      },
      required: [],
    },
  },
  {
    name: "get_trial_balance",
    description: "Get a Trial Balance report. Useful for month-end close and reconciliation. Note: Trial Balance does not support department/location breakdown in QuickBooks Online.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description: "Start date in YYYY-MM-DD format",
        },
        end_date: {
          type: "string",
          description: "End date in YYYY-MM-DD format",
        },
        accounting_method: {
          type: "string",
          description: "Accounting method: 'Accrual' (default) or 'Cash'",
        },
      },
      required: [],
    },
  },
  {
    name: "query_account_transactions",
    description: "Query all transactions affecting a specific account, across all 13 posting transaction types. Returns a consolidated list with date, type, amount (debit/credit), and description. Useful for investigating account balance discrepancies. Note: the A/R side of invoices, credit memos, and payments has no account reference in QBO's data model and cannot appear here — use account_period_summary for A/R totals.",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Account name, number (AcctNum), or ID. Examples: 'Tips', '2320', '116'"
        },
        start_date: {
          type: "string",
          description: "Start date YYYY-MM-DD (default: start of year)"
        },
        end_date: {
          type: "string",
          description: "End date YYYY-MM-DD (default: today)"
        },
        department: {
          type: "string",
          description: "Filter to specific department/location (optional)"
        }
      },
      required: ["account"]
    }
  },
  {
    name: "account_period_summary",
    description: "Get a period summary for an account: opening balance, total debits/credits, closing balance, and transaction count. Uses the General Ledger report. Supports department filtering.",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Account name, number (AcctNum), or ID",
        },
        start_date: {
          type: "string",
          description: "Start date YYYY-MM-DD (default: start of year)",
        },
        end_date: {
          type: "string",
          description: "End date YYYY-MM-DD (default: today)",
        },
        department: {
          type: "string",
          description: "Filter to specific department/location (optional)",
        },
        accounting_method: {
          type: "string",
          description: "Accounting method: 'Accrual' (default) or 'Cash'",
        },
      },
      required: ["account"],
    },
  },
  {
    name: "create_journal_entry",
    description: "Create a journal entry. Accepts account/department names (will lookup IDs automatically). Validates debits=credits before creating. Returns entry details and a link to view in QuickBooks.",
    inputSchema: {
      type: "object",
      properties: {
        txn_date: {
          type: "string",
          description: "Transaction date in YYYY-MM-DD format",
        },
        memo: {
          type: "string",
          description: "Private memo for the journal entry",
        },
        lines: {
          type: "array",
          description: "Array of line items. Provide account_name OR account_id (name preferred). Optionally provide department_name OR department_id.",
          items: {
            type: "object",
            properties: {
              account_name: {
                type: "string",
                description: "Account name (e.g., 'Tips', '2320 Tips'). Will be looked up to get ID.",
              },
              account_id: {
                type: "string",
                description: "Account ID (use if you already know it, otherwise use account_name)",
              },
              amount: {
                type: "number",
                description: "Line amount (positive number)",
              },
              posting_type: {
                type: "string",
                enum: ["Debit", "Credit"],
                description: "Whether this line is a Debit or Credit",
              },
              department_name: {
                type: "string",
                description: "Department/Location name (e.g., '20358', 'Santa Rosa'). Will be looked up to get ID.",
              },
              department_id: {
                type: "string",
                description: "Department/Location ID (use if you already know it, otherwise use department_name)",
              },
              description: {
                type: "string",
                description: "Line description (optional)",
              },
            },
            required: ["amount", "posting_type"],
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without creating (default: true)",
        },
        doc_number: {
          type: "string",
          description: "Journal number (shown as 'Journal no.' in QuickBooks). If not specified, QuickBooks will auto-assign the next number.",
        },
      },
      required: ["txn_date", "lines"],
    },
  },
  {
    name: "get_journal_entry",
    description: "Fetch a single journal entry by ID with full details including SyncToken (needed for edits). Returns formatted summary and writes full object to temp file.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The journal entry ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "edit_journal_entry",
    description: "Modify an existing journal entry. Can update date, memo, doc_number, and/or lines. For lines: provide line_id to update existing line, omit line_id to add new line, set delete=true to remove a line. Validates debits=credits before saving.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Journal entry ID to edit",
        },
        txn_date: {
          type: "string",
          description: "New transaction date in YYYY-MM-DD format (optional)",
        },
        memo: {
          type: "string",
          description: "New private memo (optional)",
        },
        doc_number: {
          type: "string",
          description: "New journal number (optional)",
        },
        lines: {
          type: "array",
          description: "Line modifications. Provide line_id to update existing line, omit to add new line.",
          items: {
            type: "object",
            properties: {
              line_id: {
                type: "string",
                description: "ID of existing line to update (omit for new line)",
              },
              account_name: {
                type: "string",
                description: "Account name/number (auto-resolved to ID)",
              },
              amount: {
                type: "number",
                description: "Line amount (positive number)",
              },
              posting_type: {
                type: "string",
                enum: ["Debit", "Credit"],
                description: "Whether this line is a Debit or Credit",
              },
              department_name: {
                type: "string",
                description: "Department/Location name (auto-resolved to ID)",
              },
              description: {
                type: "string",
                description: "Line description",
              },
              delete: {
                type: "boolean",
                description: "Set true to remove this line (requires line_id)",
              },
            },
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without saving (default: true)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "create_bill",
    description: "Create a vendor bill. Accepts vendor/account/department names (will lookup IDs automatically). Note: DepartmentRef is header-level only — for multi-department splits, create separate bills (one per department). Returns bill details and a link to view in QuickBooks.",
    inputSchema: {
      type: "object",
      properties: {
        vendor_name: {
          type: "string",
          description: "Vendor display name (e.g., 'Simplisafe', 'PG&E'). Will be looked up to get ID.",
        },
        vendor_id: {
          type: "string",
          description: "Vendor ID (use if you already know it, otherwise use vendor_name)",
        },
        txn_date: {
          type: "string",
          description: "Transaction date in YYYY-MM-DD format",
        },
        due_date: {
          type: "string",
          description: "Due date in YYYY-MM-DD format (optional)",
        },
        department_name: {
          type: "string",
          description: "Header-level department/location name (e.g., '20358', 'Cotati'). Will be looked up to get ID.",
        },
        department_id: {
          type: "string",
          description: "Header-level department/location ID (use if you already know it, otherwise use department_name)",
        },
        ap_account: {
          type: "string",
          description: "Accounts Payable account name or number (optional, defaults to standard AP)",
        },
        memo: {
          type: "string",
          description: "Private memo for the bill",
        },
        doc_number: {
          type: "string",
          description: "Reference number for the bill (optional)",
        },
        lines: {
          type: "array",
          description: "Array of expense line items. Provide account_name OR account_id (name preferred).",
          items: {
            type: "object",
            properties: {
              account_name: {
                type: "string",
                description: "Account name (e.g., 'Alarm', '6123'). Will be looked up to get ID.",
              },
              account_id: {
                type: "string",
                description: "Account ID (use if you already know it, otherwise use account_name)",
              },
              amount: {
                type: "number",
                description: "Line amount (positive number)",
              },
              description: {
                type: "string",
                description: "Line description (optional)",
              },
            },
            required: ["amount"],
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without creating (default: true)",
        },
      },
      required: ["txn_date", "lines"],
    },
  },
  {
    name: "get_bill",
    description: "Fetch a single bill by ID with full details including SyncToken (needed for edits). Returns vendor, date, due date, amount, AP account, line details.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The bill ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "edit_bill",
    description: "Modify an existing bill. Can update vendor, date, due date, memo, and/or lines. For lines: provide line_id to update existing line, omit to add new line, set delete=true to remove. Note: DepartmentRef is header-level only — lines do not support department.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Bill ID to edit",
        },
        vendor_name: {
          type: "string",
          description: "New vendor display name (e.g., 'Simplisafe', 'PG&E'). Auto-resolved to ID.",
        },
        txn_date: {
          type: "string",
          description: "New transaction date in YYYY-MM-DD format (optional)",
        },
        due_date: {
          type: "string",
          description: "New due date in YYYY-MM-DD format (optional)",
        },
        memo: {
          type: "string",
          description: "New private memo (optional)",
        },
        department_name: {
          type: "string",
          description: "Header-level department/location name (auto-resolved to ID)",
        },
        doc_number: {
          type: "string",
          description: "Reference number for the bill (optional)",
        },
        lines: {
          type: "array",
          description: "Line modifications. Provide line_id to update existing, omit to add new.",
          items: {
            type: "object",
            properties: {
              line_id: {
                type: "string",
                description: "ID of existing line to update (omit for new line)",
              },
              account_name: {
                type: "string",
                description: "Account name/number (auto-resolved to ID)",
              },
              amount: {
                type: "number",
                description: "Line amount (positive number)",
              },
              description: {
                type: "string",
                description: "Line description",
              },
              delete: {
                type: "boolean",
                description: "Set true to remove this line (requires line_id)",
              },
            },
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without saving (default: true)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_expense",
    description: "Fetch a single expense (Purchase) by ID with full details including SyncToken. Covers Expenses, Checks, and Credit Card charges. Returns payment type, account, date, amount, line details.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The expense (Purchase) ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "edit_expense",
    description: "Modify an existing expense (Purchase). Can update date, memo, payment account, and/or lines. Note: PaymentType (Cash/Check/CreditCard) cannot be changed after creation.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Expense (Purchase) ID to edit",
        },
        txn_date: {
          type: "string",
          description: "New transaction date in YYYY-MM-DD format (optional)",
        },
        memo: {
          type: "string",
          description: "New private memo (optional)",
        },
        payment_account: {
          type: "string",
          description: "New payment account name/number (Bank or Credit Card account)",
        },
        lines: {
          type: "array",
          description: "Line modifications. Provide line_id to update existing, omit to add new.",
          items: {
            type: "object",
            properties: {
              line_id: {
                type: "string",
                description: "ID of existing line to update (omit for new line)",
              },
              account_name: {
                type: "string",
                description: "Account name/number (auto-resolved to ID)",
              },
              amount: {
                type: "number",
                description: "Line amount (positive number)",
              },
              description: {
                type: "string",
                description: "Line description",
              },
              delete: {
                type: "boolean",
                description: "Set true to remove this line (requires line_id)",
              },
            },
          },
        },
        department_name: {
          type: "string",
          description: "Header-level department/location name (auto-resolved to ID)",
        },
        entity_name: {
          type: "string",
          description: "Payee/vendor display name (e.g., 'Cozzini Bros., Inc.'). Will be looked up to get ID.",
        },
        entity_id: {
          type: "string",
          description: "Payee/vendor ID (use if you already know it, otherwise use entity_name)",
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without saving (default: true)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "create_expense",
    description: "Create an expense (Purchase). Accepts account/department/vendor names (will lookup IDs automatically). Covers Cash, Check, and Credit Card payment types. Note: PaymentType cannot be changed after creation. DepartmentRef is header-level only. Returns expense details and a link to view in QuickBooks.",
    inputSchema: {
      type: "object",
      properties: {
        payment_type: {
          type: "string",
          enum: ["Cash", "Check", "CreditCard"],
          description: "Payment method: 'Cash', 'Check', or 'CreditCard'. Cannot be changed after creation.",
        },
        payment_account: {
          type: "string",
          description: "Bank or credit card account name or number (e.g., 'PLAT BUS CHECKING', '5752'). Will be looked up to get ID.",
        },
        txn_date: {
          type: "string",
          description: "Transaction date in YYYY-MM-DD format",
        },
        entity_name: {
          type: "string",
          description: "Payee/vendor display name (e.g., 'Simplisafe', 'PG&E'). Will be looked up to get ID.",
        },
        entity_id: {
          type: "string",
          description: "Payee/vendor ID (use if you already know it, otherwise use entity_name)",
        },
        department_name: {
          type: "string",
          description: "Header-level department/location name (e.g., '20358', 'Cotati'). Will be looked up to get ID.",
        },
        department_id: {
          type: "string",
          description: "Header-level department/location ID (use if you already know it, otherwise use department_name)",
        },
        memo: {
          type: "string",
          description: "Private memo for the expense",
        },
        doc_number: {
          type: "string",
          description: "Reference number for the expense (optional)",
        },
        lines: {
          type: "array",
          description: "Array of expense line items. Provide account_name OR account_id (name preferred).",
          items: {
            type: "object",
            properties: {
              account_name: {
                type: "string",
                description: "Account name (e.g., 'Alarm', '6123'). Will be looked up to get ID.",
              },
              account_id: {
                type: "string",
                description: "Account ID (use if you already know it, otherwise use account_name)",
              },
              amount: {
                type: "number",
                description: "Line amount (positive number)",
              },
              description: {
                type: "string",
                description: "Line description (optional)",
              },
            },
            required: ["amount"],
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without creating (default: true)",
        },
      },
      required: ["payment_type", "payment_account", "txn_date", "lines"],
    },
  },
  {
    name: "get_sales_receipt",
    description: "Fetch a single sales receipt by ID with full details including SyncToken (needed for edits). Returns customer, date, deposit account, department, line details with items/qty/price.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The sales receipt ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "edit_sales_receipt",
    description: "Modify an existing sales receipt. Can update date, memo, deposit account, department, and/or lines. For lines: provide line_id to update existing line, omit line_id to add new line (requires item_name), set delete=true to remove.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Sales receipt ID to edit",
        },
        txn_date: {
          type: "string",
          description: "New transaction date in YYYY-MM-DD format (optional)",
        },
        memo: {
          type: "string",
          description: "New private memo (optional)",
        },
        deposit_to_account: {
          type: "string",
          description: "New deposit account name/number (Bank account)",
        },
        department_name: {
          type: "string",
          description: "Header-level department/location name (auto-resolved to ID)",
        },
        lines: {
          type: "array",
          description: "Line modifications. Provide line_id to update existing line, omit to add new line.",
          items: {
            type: "object",
            properties: {
              line_id: {
                type: "string",
                description: "ID of existing line to update (omit for new line)",
              },
              item_name: {
                type: "string",
                description: "Item (product/service) name for new lines (e.g., 'Sales', 'Catering'). Auto-resolved to ID.",
              },
              item_id: {
                type: "string",
                description: "Item ID (use if you already know it, otherwise use item_name)",
              },
              amount: {
                type: "number",
                description: "Line amount (positive number)",
              },
              qty: {
                type: "number",
                description: "Quantity (default: 1)",
              },
              unit_price: {
                type: "number",
                description: "Price per unit (if omitted, computed from amount / qty)",
              },
              description: {
                type: "string",
                description: "Line description",
              },
              delete: {
                type: "boolean",
                description: "Set true to remove this line (requires line_id)",
              },
            },
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without saving (default: true)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "create_sales_receipt",
    description: "Create a sales receipt. Accepts item/customer/department names (will lookup IDs automatically). Lines reference items (products/services) not accounts. Returns receipt details and a link to view in QuickBooks.",
    inputSchema: {
      type: "object",
      properties: {
        txn_date: {
          type: "string",
          description: "Transaction date in YYYY-MM-DD format",
        },
        customer_name: {
          type: "string",
          description: "Customer display name (e.g., 'Cash Sales'). Will be looked up to get ID.",
        },
        customer_id: {
          type: "string",
          description: "Customer ID (use if you already know it, otherwise use customer_name)",
        },
        deposit_to_account: {
          type: "string",
          description: "Bank account name or number to deposit into (e.g., 'Undeposited Funds', '1000'). Will be looked up to get ID.",
        },
        department_name: {
          type: "string",
          description: "Header-level department/location name (e.g., '20358', 'Cotati'). Will be looked up to get ID.",
        },
        department_id: {
          type: "string",
          description: "Header-level department/location ID (use if you already know it, otherwise use department_name)",
        },
        memo: {
          type: "string",
          description: "Private memo for the sales receipt",
        },
        doc_number: {
          type: "string",
          description: "Reference number for the sales receipt (optional)",
        },
        lines: {
          type: "array",
          description: "Array of line items. Each line references an item (product/service). Provide item_name OR item_id (name preferred).",
          items: {
            type: "object",
            properties: {
              item_name: {
                type: "string",
                description: "Item (product/service) name (e.g., 'Sales', 'Catering'). Will be looked up to get ID.",
              },
              item_id: {
                type: "string",
                description: "Item ID (use if you already know it, otherwise use item_name)",
              },
              amount: {
                type: "number",
                description: "Line amount (positive or negative). Negative for adjustments/discounts.",
              },
              qty: {
                type: "number",
                description: "Quantity (default: 1)",
              },
              unit_price: {
                type: "number",
                description: "Price per unit (if omitted, computed from amount / qty)",
              },
              description: {
                type: "string",
                description: "Line description (optional)",
              },
            },
            required: [],
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without creating (default: true)",
        },
      },
      required: ["txn_date", "lines"],
    },
  },
  {
    name: "create_invoice",
    description: "Create an invoice. Accepts item/customer/department names (will lookup IDs automatically). Either customer_name or customer_id is REQUIRED — invoices must have a customer. Lines use SalesItemLineDetail (product/service references, not accounts). Returns invoice details and a link to view in QuickBooks.",
    inputSchema: {
      type: "object",
      properties: {
        txn_date: {
          type: "string",
          description: "Transaction date in YYYY-MM-DD format",
        },
        customer_name: {
          type: "string",
          description: "Customer display name (e.g., 'Cash Sales'). Will be looked up to get ID.",
        },
        customer_id: {
          type: "string",
          description: "Customer ID (use if you already know it, otherwise use customer_name)",
        },
        due_date: {
          type: "string",
          description: "Due date in YYYY-MM-DD format (optional)",
        },
        department_name: {
          type: "string",
          description: "Header-level department/location name (e.g., '20358', 'Cotati'). Will be looked up to get ID.",
        },
        department_id: {
          type: "string",
          description: "Header-level department/location ID (use if you already know it, otherwise use department_name)",
        },
        memo: {
          type: "string",
          description: "Private memo for the invoice (internal, not visible to customer)",
        },
        customer_memo: {
          type: "string",
          description: "Customer-facing message visible on the invoice",
        },
        bill_email: {
          type: "string",
          description: "Email address to send the invoice to. Required if you want QuickBooks to email the invoice.",
        },
        sales_term_ref: {
          type: "string",
          description: "Payment terms name (e.g., 'Net 30', 'Due on receipt'). Will be looked up to get ID.",
        },
        allow_online_credit_card_payment: {
          type: "boolean",
          description: "Allow customer to pay this invoice with a credit card online. Must be explicitly set — company defaults do not apply via API.",
        },
        allow_online_ach_payment: {
          type: "boolean",
          description: "Allow customer to pay this invoice via bank transfer (ACH) online. Must be explicitly set — company defaults do not apply via API.",
        },
        doc_number: {
          type: "string",
          description: "Reference number for the invoice (optional)",
        },
        lines: {
          type: "array",
          description: "Array of line items. Each line references an item (product/service). Provide item_name OR item_id (name preferred).",
          items: {
            type: "object",
            properties: {
              item_name: {
                type: "string",
                description: "Item (product/service) name (e.g., 'Sales', 'Catering'). Will be looked up to get ID.",
              },
              item_id: {
                type: "string",
                description: "Item ID (use if you already know it, otherwise use item_name)",
              },
              amount: {
                type: "number",
                description: "Line amount (positive or negative). Negative for adjustments/discounts.",
              },
              qty: {
                type: "number",
                description: "Quantity (default: 1)",
              },
              unit_price: {
                type: "number",
                description: "Price per unit (if omitted, computed from amount / qty)",
              },
              description: {
                type: "string",
                description: "Line description (optional)",
              },
            },
            required: [],
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without creating (default: true)",
        },
      },
      required: ["txn_date", "lines"],
    },
  },
  {
    name: "get_invoice",
    description: "Fetch a single invoice by ID with full details including SyncToken (needed for edits). Returns customer, date, due date, balance, department, line details with items/qty/price.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The invoice ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "edit_invoice",
    description: "Modify an existing invoice. Can update date, due date, memo, customer, department, terms, email, online payment settings, and/or lines. For lines: provide line_id to update existing line, omit line_id to add new line (requires item_name), set delete=true to remove.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Invoice ID to edit",
        },
        txn_date: {
          type: "string",
          description: "New transaction date in YYYY-MM-DD format (optional)",
        },
        due_date: {
          type: "string",
          description: "New due date in YYYY-MM-DD format (optional)",
        },
        memo: {
          type: "string",
          description: "New private memo (optional)",
        },
        customer_memo: {
          type: "string",
          description: "New customer-facing message visible on the invoice",
        },
        bill_email: {
          type: "string",
          description: "New email address to send the invoice to",
        },
        sales_term_ref: {
          type: "string",
          description: "Payment terms name (e.g., 'Net 30'). Auto-resolved to ID.",
        },
        allow_online_credit_card_payment: {
          type: "boolean",
          description: "Allow customer to pay with credit card online",
        },
        allow_online_ach_payment: {
          type: "boolean",
          description: "Allow customer to pay via bank transfer (ACH) online",
        },
        customer_name: {
          type: "string",
          description: "New customer display name (auto-resolved to ID)",
        },
        department_name: {
          type: "string",
          description: "Header-level department/location name (auto-resolved to ID)",
        },
        lines: {
          type: "array",
          description: "Line modifications. Provide line_id to update existing line, omit to add new line.",
          items: {
            type: "object",
            properties: {
              line_id: {
                type: "string",
                description: "ID of existing line to update (omit for new line)",
              },
              item_name: {
                type: "string",
                description: "Item (product/service) name for new lines (e.g., 'Sales', 'Catering'). Auto-resolved to ID.",
              },
              item_id: {
                type: "string",
                description: "Item ID (use if you already know it, otherwise use item_name)",
              },
              amount: {
                type: "number",
                description: "Line amount (positive number)",
              },
              qty: {
                type: "number",
                description: "Quantity (default: 1)",
              },
              unit_price: {
                type: "number",
                description: "Price per unit (if omitted, computed from amount / qty)",
              },
              description: {
                type: "string",
                description: "Line description",
              },
              delete: {
                type: "boolean",
                description: "Set true to remove this line (requires line_id)",
              },
            },
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without saving (default: true)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "create_deposit",
    description: "Create a bank deposit. Accepts account/department/vendor names (will lookup IDs automatically). Lines represent the sources of the deposit — amounts can be positive (income) or negative (fees, deductions). QuickBooks computes the total from line amounts. Returns deposit details and a link to view in QuickBooks.",
    inputSchema: {
      type: "object",
      properties: {
        deposit_to_account: {
          type: "string",
          description: "Bank account name or number receiving the deposit (e.g., 'PLAT BUS CHECKING', '5752'). Will be looked up to get ID.",
        },
        txn_date: {
          type: "string",
          description: "Transaction date in YYYY-MM-DD format",
        },
        lines: {
          type: "array",
          description: "Array of deposit line items. Each line represents a source of the deposit. Amounts can be positive or negative.",
          items: {
            type: "object",
            properties: {
              amount: {
                type: "number",
                description: "Line amount (positive or negative). Negative for fees/deductions.",
              },
              account_name: {
                type: "string",
                description: "Source account name or number (e.g., 'House Account', '1340', '6210 Bank Service Charges'). Will be looked up to get ID.",
              },
              account_id: {
                type: "string",
                description: "Account ID (use if you already know it, otherwise use account_name)",
              },
              description: {
                type: "string",
                description: "Line description (optional)",
              },
              entity_name: {
                type: "string",
                description: "Vendor or customer name (e.g., 'Square Inc.'). Sets Entity on the deposit line. Will be looked up to get ID.",
              },
              entity_id: {
                type: "string",
                description: "Entity ID (use if you already know it, otherwise use entity_name)",
              },
            },
            required: ["amount"],
          },
        },
        department_name: {
          type: "string",
          description: "Header-level department/location name (e.g., '20358', 'Cotati'). Will be looked up to get ID.",
        },
        department_id: {
          type: "string",
          description: "Header-level department/location ID (use if you already know it, otherwise use department_name)",
        },
        memo: {
          type: "string",
          description: "Private memo for the deposit",
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without creating (default: true)",
        },
      },
      required: ["deposit_to_account", "txn_date", "lines"],
    },
  },
  {
    name: "get_deposit",
    description: "Fetch a single deposit by ID with full details including SyncToken (needed for edits). Returns deposit account, date, memo, and line details showing source accounts and amounts.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The deposit ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "edit_deposit",
    description: "Modify an existing deposit. Can update date, memo, deposit account, department, and/or lines. CRITICAL for line changes: The QB Deposit API does NOT replace lines - it merges them. Lines WITH line_id update existing lines. Lines WITHOUT line_id are ADDED as new. Lines NOT included are KEPT unchanged. To 'delete' a line, you must include ALL existing lines with their line_ids and set unwanted lines to amount: 0. Line amounts must sum to the original deposit total (use expected_total to override for corrupted deposits).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Deposit ID to edit",
        },
        txn_date: {
          type: "string",
          description: "New transaction date in YYYY-MM-DD format (optional)",
        },
        memo: {
          type: "string",
          description: "New private memo (optional)",
        },
        deposit_to_account: {
          type: "string",
          description: "New deposit account name/number (Bank account)",
        },
        department_name: {
          type: "string",
          description: "Header-level department/location name (auto-resolved to ID)",
        },
        lines: {
          type: "array",
          description: "IMPORTANT: You MUST include ALL existing lines with their line_ids. Lines without line_id are ADDED (not replaced). Lines not included are KEPT (not deleted). To 'delete' a line, set its amount to 0. Line amounts must sum to original deposit total.",
          items: {
            type: "object",
            properties: {
              line_id: {
                type: "string",
                description: "ID of existing line to update (preserves Entity/Vendor reference). Omit to create new line.",
              },
              amount: {
                type: "number",
                description: "Line amount (positive or negative number)",
              },
              account_name: {
                type: "string",
                description: "Source account name/number (auto-resolved to ID)",
              },
              description: {
                type: "string",
                description: "Line description",
              },
            },
            required: ["amount", "account_name"],
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without saving (default: true)",
        },
        expected_total: {
          type: "number",
          description: "Override total validation with this expected amount (for fixing corrupted deposits). Lines must sum to this value instead of current deposit total.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "create_vendor_credit",
    description: "Create a vendor credit. Accepts vendor/account/department names (will lookup IDs automatically). Lines represent credit amounts applied to expense accounts. Returns credit details and a link to view in QuickBooks.",
    inputSchema: {
      type: "object",
      properties: {
        vendor_name: {
          type: "string",
          description: "Vendor display name (e.g., 'Acme Corp'). Will be looked up to get ID.",
        },
        vendor_id: {
          type: "string",
          description: "Vendor ID (use if you already know it, otherwise use vendor_name)",
        },
        txn_date: {
          type: "string",
          description: "Transaction date in YYYY-MM-DD format",
        },
        department_name: {
          type: "string",
          description: "Header-level department/location name (e.g., '20358', 'Cotati'). Will be looked up to get ID.",
        },
        department_id: {
          type: "string",
          description: "Header-level department/location ID (use if you already know it, otherwise use department_name)",
        },
        ap_account: {
          type: "string",
          description: "Accounts Payable account name or number (optional, defaults to standard AP)",
        },
        memo: {
          type: "string",
          description: "Private memo for the vendor credit",
        },
        doc_number: {
          type: "string",
          description: "Reference number for the vendor credit (optional)",
        },
        lines: {
          type: "array",
          description: "Array of line items. Each line credits an expense account.",
          items: {
            type: "object",
            properties: {
              amount: {
                type: "number",
                description: "Line amount (positive number)",
              },
              account_name: {
                type: "string",
                description: "Account name or number (e.g., '5000 Cost of Goods Sold'). Will be looked up to get ID.",
              },
              account_id: {
                type: "string",
                description: "Account ID (use if you already know it, otherwise use account_name)",
              },
              description: {
                type: "string",
                description: "Line description (optional)",
              },
            },
            required: ["amount"],
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without creating (default: true)",
        },
      },
      required: ["txn_date", "lines"],
    },
  },
  {
    name: "get_vendor_credit",
    description: "Fetch a single vendor credit by ID with full details including SyncToken (needed for edits). Returns vendor, date, memo, ref number, AP account, and line details showing expense accounts and amounts.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The vendor credit ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "edit_vendor_credit",
    description: "Modify an existing vendor credit. Can update vendor, date, memo, ref number, and/or lines. For lines: provide line_id to update existing line, omit line_id to add new line (requires amount and account_name), set delete=true to remove. Note: DepartmentRef is header-level only — lines do not support department.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Vendor Credit ID to edit",
        },
        vendor_name: {
          type: "string",
          description: "New vendor display name (auto-resolved to ID)",
        },
        txn_date: {
          type: "string",
          description: "New transaction date in YYYY-MM-DD format (optional)",
        },
        memo: {
          type: "string",
          description: "New private memo (optional)",
        },
        doc_number: {
          type: "string",
          description: "New reference number (optional)",
        },
        lines: {
          type: "array",
          description: "Line modifications. Provide line_id to update existing line, omit to add new line.",
          items: {
            type: "object",
            properties: {
              line_id: {
                type: "string",
                description: "ID of existing line to update (omit for new line)",
              },
              amount: {
                type: "number",
                description: "Line amount (positive number)",
              },
              account_name: {
                type: "string",
                description: "Account name or number (auto-resolved to ID)",
              },
              description: {
                type: "string",
                description: "Line description",
              },
              delete: {
                type: "boolean",
                description: "Set true to remove this line (requires line_id)",
              },
            },
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without saving (default: true)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "create_bill_payment",
    description: "Create a bill payment (the QBO 'check' / 'pay bills' flow). Pays one or more existing bills and optionally applies vendor credits, clearing Accounts Payable. Use this to record vendor ACH/EFT debits or checks so the bank feed can match them — especially when a bank charge equals bills minus credit memos. Amounts default to each bill's open balance and each credit's remaining balance. Returns payment details and a link to view in QuickBooks.",
    inputSchema: {
      type: "object",
      properties: {
        vendor_name: {
          type: "string",
          description: "Vendor display name (e.g., 'US Foods'). Will be looked up to get ID.",
        },
        vendor_id: {
          type: "string",
          description: "Vendor ID (use if you already know it, otherwise use vendor_name)",
        },
        payment_account: {
          type: "string",
          description: "Bank account name or number the payment is drawn from (e.g., 'PLAT BUS CHECKING', '5752'). Will be looked up to get ID.",
        },
        txn_date: {
          type: "string",
          description: "Payment date in YYYY-MM-DD format (use the bank debit date for bank-feed matching)",
        },
        memo: {
          type: "string",
          description: "Private memo for the payment",
        },
        doc_number: {
          type: "string",
          description: "Reference number, e.g., check number or EFT reference (optional)",
        },
        bills: {
          type: "array",
          description: "Bills to pay. Each bill must belong to the vendor and have an open balance.",
          items: {
            type: "object",
            properties: {
              bill_id: {
                type: "string",
                description: "Bill ID to pay",
              },
              amount: {
                type: "number",
                description: "Amount to apply (optional, defaults to the bill's full open balance)",
              },
            },
            required: ["bill_id"],
          },
        },
        credits: {
          type: "array",
          description: "Vendor credits to apply against the bills (optional). Each credit must belong to the vendor and have remaining balance.",
          items: {
            type: "object",
            properties: {
              vendor_credit_id: {
                type: "string",
                description: "Vendor credit ID to apply",
              },
              amount: {
                type: "number",
                description: "Amount of credit to apply (optional, defaults to the credit's full remaining balance)",
              },
            },
            required: ["vendor_credit_id"],
          },
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without creating (default: true)",
        },
      },
      required: ["payment_account", "txn_date", "bills"],
    },
  },
  {
    name: "get_bill_payment",
    description: "Fetch a single bill payment by ID with full details including SyncToken. Shows vendor, date, pay type, bank account, linked bills/credits with applied amounts, and flags any unapplied amount (payment total not matching net applied lines).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The bill payment ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_entity",
    description: "Permanently delete a QuickBooks transaction. Supports journal entries, bills, invoices, deposits, sales receipts, expenses, vendor credits, and bill payments. Uses a two-step flow: first call previews what will be deleted, second call with confirm=true executes the deletion. Note: Customers cannot be deleted — use edit_customer with active=false to deactivate instead.",
    inputSchema: {
      type: "object",
      properties: {
        entity_type: {
          type: "string",
          enum: ["journal_entry", "bill", "invoice", "deposit", "sales_receipt", "expense", "vendor_credit", "bill_payment"],
          description: "The type of entity to delete.",
        },
        id: {
          type: "string",
          description: "The entity ID to delete.",
        },
        confirm: {
          type: "boolean",
          description: "If true, execute the deletion. If false (default), show a preview of what will be deleted.",
        },
      },
      required: ["entity_type", "id"],
    },
  },
  {
    name: "create_customer",
    description: "Create a customer or sub-customer. Accepts name parts, contact info, addresses, and hierarchy settings. Use parent_ref to create sub-customers or jobs. Returns customer details and a link to view in QuickBooks.",
    inputSchema: {
      type: "object",
      properties: {
        display_name: {
          type: "string",
          description: "Primary display name (must be unique in QuickBooks)",
        },
        given_name: {
          type: "string",
          description: "First/given name (optional)",
        },
        middle_name: {
          type: "string",
          description: "Middle name (optional)",
        },
        family_name: {
          type: "string",
          description: "Last/family name (optional)",
        },
        suffix: {
          type: "string",
          description: "Name suffix, e.g., 'Jr.' (optional)",
        },
        company_name: {
          type: "string",
          description: "Company name (optional)",
        },
        email: {
          type: "string",
          description: "Primary email address (optional)",
        },
        phone: {
          type: "string",
          description: "Primary phone number (optional)",
        },
        mobile: {
          type: "string",
          description: "Mobile phone number (optional)",
        },
        bill_address: {
          type: "object",
          description: "Billing address (optional)",
          properties: {
            line1: { type: "string" },
            line2: { type: "string" },
            line3: { type: "string" },
            line4: { type: "string" },
            line5: { type: "string" },
            city: { type: "string" },
            country_sub_division_code: { type: "string", description: "State/province code" },
            postal_code: { type: "string" },
            country: { type: "string" },
            lat: { type: "string" },
            long: { type: "string" },
          },
        },
        ship_address: {
          type: "object",
          description: "Shipping address (optional, same shape as bill_address)",
          properties: {
            line1: { type: "string" },
            line2: { type: "string" },
            line3: { type: "string" },
            line4: { type: "string" },
            line5: { type: "string" },
            city: { type: "string" },
            country_sub_division_code: { type: "string", description: "State/province code" },
            postal_code: { type: "string" },
            country: { type: "string" },
            lat: { type: "string" },
            long: { type: "string" },
          },
        },
        notes: {
          type: "string",
          description: "Notes about the customer (optional)",
        },
        taxable: {
          type: "boolean",
          description: "Whether the customer is taxable (optional)",
        },
        parent_ref: {
          type: "string",
          description: "Parent customer name or ID to create a sub-customer or job. Will be looked up to get ID.",
        },
        job: {
          type: "boolean",
          description: "Mark this customer as a job (default: false). Jobs track work for a parent customer.",
        },
        bill_with_parent: {
          type: "boolean",
          description: "If true, invoices for this sub-customer are billed to the parent (default: false)",
        },
        preferred_delivery_method: {
          type: "string",
          enum: ["Print", "Email", "None"],
          description: "How invoices are delivered: Print, Email, or None",
        },
        sales_term_ref: {
          type: "string",
          description: "Default payment terms name (e.g., 'Net 30'). Will be looked up to get ID.",
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without creating (default: true)",
        },
      },
      required: ["display_name"],
    },
  },
  {
    name: "get_customer",
    description: "Fetch a single customer by ID with full details including SyncToken (needed for edits). Returns name, contact info, addresses, balance, hierarchy (parent/sub-customer), and active status.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The customer ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "edit_customer",
    description: "Modify an existing customer. Can update name, contact info, addresses, notes, taxable status, active status, hierarchy (parent/sub-customer), delivery method, and payment terms. Set active=false to deactivate (QuickBooks equivalent of delete).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Customer ID to edit",
        },
        display_name: {
          type: "string",
          description: "New display name (must be unique in QuickBooks)",
        },
        given_name: {
          type: "string",
          description: "New first/given name",
        },
        middle_name: {
          type: "string",
          description: "New middle name",
        },
        family_name: {
          type: "string",
          description: "New last/family name",
        },
        suffix: {
          type: "string",
          description: "New name suffix",
        },
        company_name: {
          type: "string",
          description: "New company name",
        },
        email: {
          type: "string",
          description: "New primary email address",
        },
        phone: {
          type: "string",
          description: "New primary phone number",
        },
        mobile: {
          type: "string",
          description: "New mobile phone number",
        },
        bill_address: {
          type: "object",
          description: "New billing address",
          properties: {
            line1: { type: "string" },
            line2: { type: "string" },
            line3: { type: "string" },
            line4: { type: "string" },
            line5: { type: "string" },
            city: { type: "string" },
            country_sub_division_code: { type: "string", description: "State/province code" },
            postal_code: { type: "string" },
            country: { type: "string" },
            lat: { type: "string" },
            long: { type: "string" },
          },
        },
        ship_address: {
          type: "object",
          description: "New shipping address",
          properties: {
            line1: { type: "string" },
            line2: { type: "string" },
            line3: { type: "string" },
            line4: { type: "string" },
            line5: { type: "string" },
            city: { type: "string" },
            country_sub_division_code: { type: "string", description: "State/province code" },
            postal_code: { type: "string" },
            country: { type: "string" },
            lat: { type: "string" },
            long: { type: "string" },
          },
        },
        notes: {
          type: "string",
          description: "New notes about the customer",
        },
        taxable: {
          type: "boolean",
          description: "Whether the customer is taxable",
        },
        active: {
          type: "boolean",
          description: "Set to false to deactivate customer (QuickBooks equivalent of delete)",
        },
        parent_ref: {
          type: "string",
          description: "Parent customer name or ID (makes this a sub-customer). Auto-resolved to ID.",
        },
        job: {
          type: "boolean",
          description: "Mark as a job (tracks work for a parent customer)",
        },
        bill_with_parent: {
          type: "boolean",
          description: "Bill this sub-customer with its parent",
        },
        preferred_delivery_method: {
          type: "string",
          enum: ["Print", "Email", "None"],
          description: "How invoices are delivered: Print, Email, or None",
        },
        sales_term_ref: {
          type: "string",
          description: "Default payment terms name (e.g., 'Net 30'). Auto-resolved to ID.",
        },
        draft: {
          type: "boolean",
          description: "If true, validate and show preview without saving (default: true)",
        },
      },
      required: ["id"],
    },
  },
];
