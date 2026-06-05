// Tool registry and dispatcher with auth retry

import QuickBooks from "node-quickbooks";
import { getClient, clearCredentialsCache, isAuthError } from "../client/index.js";
import {
  handleGetCompanyInfo,
  handleQuery,
  handleListAccounts,
  handleGetProfitLoss,
  handleGetBalanceSheet,
  handleGetTrialBalance,
  handleQueryAccountTransactions,
  handleAccountPeriodSummary,
  handleCreateJournalEntry,
  handleGetJournalEntry,
  handleEditJournalEntry,
  handleCreateBill,
  handleGetBill,
  handleEditBill,
  handleCreateExpense,
  handleGetExpense,
  handleEditExpense,
  handleCreateSalesReceipt,
  handleGetSalesReceipt,
  handleEditSalesReceipt,
  handleCreateInvoice,
  handleGetInvoice,
  handleEditInvoice,
  handleCreateDeposit,
  handleGetDeposit,
  handleEditDeposit,
  handleCreateVendorCredit,
  handleGetVendorCredit,
  handleEditVendorCredit,
  handleCreateBillPayment,
  handleGetBillPayment,
  handleCreateCustomer,
  handleGetCustomer,
  handleEditCustomer,
  handleDeleteEntity,
  handleAuthenticate,
} from "./handlers/index.js";

export { toolDefinitions } from "./definitions.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (client: QuickBooks, args: Record<string, unknown>) => Promise<ToolResult>;

// Tool handler registry
const toolHandlers = new Map<string, ToolHandler>();

// Register all tools
toolHandlers.set("get_company_info", (client) => handleGetCompanyInfo(client));
toolHandlers.set("query", (client, args) => handleQuery(client, args as { query: string }));
toolHandlers.set("list_accounts", (client, args) => handleListAccounts(client, args as { account_type?: string; active_only?: boolean }));
toolHandlers.set("get_profit_loss", (client, args) => handleGetProfitLoss(client, args as Parameters<typeof handleGetProfitLoss>[1]));
toolHandlers.set("get_balance_sheet", (client, args) => handleGetBalanceSheet(client, args as Parameters<typeof handleGetBalanceSheet>[1]));
toolHandlers.set("get_trial_balance", (client, args) => handleGetTrialBalance(client, args as Parameters<typeof handleGetTrialBalance>[1]));
toolHandlers.set("query_account_transactions", (client, args) => handleQueryAccountTransactions(client, args as Parameters<typeof handleQueryAccountTransactions>[1]));
toolHandlers.set("account_period_summary", (client, args) => handleAccountPeriodSummary(client, args as Parameters<typeof handleAccountPeriodSummary>[1]));
toolHandlers.set("create_journal_entry", (client, args) => handleCreateJournalEntry(client, args as Parameters<typeof handleCreateJournalEntry>[1]));
toolHandlers.set("get_journal_entry", (client, args) => handleGetJournalEntry(client, args as { id: string }));
toolHandlers.set("edit_journal_entry", (client, args) => handleEditJournalEntry(client, args as Parameters<typeof handleEditJournalEntry>[1]));
toolHandlers.set("create_bill", (client, args) => handleCreateBill(client, args as Parameters<typeof handleCreateBill>[1]));
toolHandlers.set("get_bill", (client, args) => handleGetBill(client, args as { id: string }));
toolHandlers.set("edit_bill", (client, args) => handleEditBill(client, args as Parameters<typeof handleEditBill>[1]));
toolHandlers.set("create_expense", (client, args) => handleCreateExpense(client, args as Parameters<typeof handleCreateExpense>[1]));
toolHandlers.set("get_expense", (client, args) => handleGetExpense(client, args as { id: string }));
toolHandlers.set("edit_expense", (client, args) => handleEditExpense(client, args as Parameters<typeof handleEditExpense>[1]));
toolHandlers.set("create_sales_receipt", (client, args) => handleCreateSalesReceipt(client, args as Parameters<typeof handleCreateSalesReceipt>[1]));
toolHandlers.set("get_sales_receipt", (client, args) => handleGetSalesReceipt(client, args as { id: string }));
toolHandlers.set("edit_sales_receipt", (client, args) => handleEditSalesReceipt(client, args as Parameters<typeof handleEditSalesReceipt>[1]));
toolHandlers.set("create_invoice", (client, args) => handleCreateInvoice(client, args as Parameters<typeof handleCreateInvoice>[1]));
toolHandlers.set("get_invoice", (client, args) => handleGetInvoice(client, args as { id: string }));
toolHandlers.set("edit_invoice", (client, args) => handleEditInvoice(client, args as Parameters<typeof handleEditInvoice>[1]));
toolHandlers.set("create_deposit", (client, args) => handleCreateDeposit(client, args as Parameters<typeof handleCreateDeposit>[1]));
toolHandlers.set("get_deposit", (client, args) => handleGetDeposit(client, args as { id: string }));
toolHandlers.set("edit_deposit", (client, args) => handleEditDeposit(client, args as Parameters<typeof handleEditDeposit>[1]));
toolHandlers.set("create_vendor_credit", (client, args) => handleCreateVendorCredit(client, args as Parameters<typeof handleCreateVendorCredit>[1]));
toolHandlers.set("get_vendor_credit", (client, args) => handleGetVendorCredit(client, args as { id: string }));
toolHandlers.set("edit_vendor_credit", (client, args) => handleEditVendorCredit(client, args as Parameters<typeof handleEditVendorCredit>[1]));
toolHandlers.set("create_billpayment", (client, args) => handleCreateBillPayment(client, args as Parameters<typeof handleCreateBillPayment>[1]));
toolHandlers.set("get_billpayment", (client, args) => handleGetBillPayment(client, args as { id: string }));
toolHandlers.set("create_customer", (client, args) => handleCreateCustomer(client, args as Parameters<typeof handleCreateCustomer>[1]));
toolHandlers.set("get_customer", (client, args) => handleGetCustomer(client, args as { id: string }));
toolHandlers.set("edit_customer", (client, args) => handleEditCustomer(client, args as Parameters<typeof handleEditCustomer>[1]));
toolHandlers.set("delete_entity", (client, args) => handleDeleteEntity(client, args as Parameters<typeof handleDeleteEntity>[1]));

// Execute tool with auth retry logic
export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  // Special case: qbo_authenticate doesn't need a QuickBooks client
  if (name === "qbo_authenticate") {
    return handleAuthenticate(args as { authorization_code?: string; realm_id?: string });
  }

  const handler = toolHandlers.get(name);
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const executeOperation = async () => {
    const client = await getClient();
    return handler(client, args);
  };

  // Execute with retry on auth failure
  try {
    return await executeOperation();
  } catch (error) {
    if (isAuthError(error)) {
      // Clear cache and retry once with fresh credentials from Secrets Manager
      clearCredentialsCache();
      try {
        return await executeOperation();
      } catch (retryError) {
        // If retry also fails, return that error
        const errorMessage = typeof retryError === 'object' && retryError !== null
          ? JSON.stringify(retryError, null, 2)
          : String(retryError);
        return {
          content: [{ type: "text", text: `Error after retry: ${errorMessage}` }],
          isError: true,
        };
      }
    }

    let errorMessage: string;
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'object' && error !== null) {
      // node-quickbooks often returns error objects with Fault property
      errorMessage = JSON.stringify(error, null, 2);
    } else {
      errorMessage = String(error);
    }
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
}
