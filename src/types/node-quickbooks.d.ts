declare module "node-quickbooks" {
  type Callback<T> = (err: Error | null, result: T) => void;

  interface TokenInfo {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    x_refresh_token_expires_in: number;
  }

  class QuickBooks {
    constructor(
      consumerKey: string,
      consumerSecret: string,
      oauthToken: string,
      oauthTokenSecret: string | false,
      realmId: string,
      useSandbox: boolean,
      debug: boolean,
      minorVer: number | null,
      oAuthVer: string,
      refreshToken: string
    );

    // Allow dynamic method access for finder methods
    [key: string]: unknown;

    // Public instance fields set by the constructor. src/client/rest.ts reads
    // these to reach entities that have no wrapper method below.
    readonly endpoint: string;   // ".../v3/company/" (sandbox or production)
    readonly realmId: string;
    readonly token: string;      // OAuth 2.0 access token
    readonly minorversion: number;

    // Token management
    refreshAccessToken(callback: Callback<TokenInfo>): void;

    // Company
    getCompanyInfo(realmId: string, callback: Callback<unknown>): void;

    // Generic finder methods - accept query strings or criteria objects
    findCustomers(criteria: object | string, callback: Callback<unknown>): void;
    findVendors(criteria: object | string, callback: Callback<unknown>): void;
    findAccounts(criteria: object | string, callback: Callback<unknown>): void;
    findInvoices(criteria: object | string, callback: Callback<unknown>): void;
    findBills(criteria: object | string, callback: Callback<unknown>): void;
    findItems(criteria: object | string, callback: Callback<unknown>): void;
    findDepartments(criteria: object | string, callback: Callback<unknown>): void;
    findJournalEntries(criteria: object | string, callback: Callback<unknown>): void;
    findPurchases(criteria: object | string, callback: Callback<unknown>): void;
    findPayments(criteria: object | string, callback: Callback<unknown>): void;
    findSalesReceipts(criteria: object | string, callback: Callback<unknown>): void;
    findDeposits(criteria: object | string, callback: Callback<unknown>): void;
    findEmployees(criteria: object | string, callback: Callback<unknown>): void;
    findEstimates(criteria: object | string, callback: Callback<unknown>): void;
    findCreditmemos(criteria: object | string, callback: Callback<unknown>): void;
    findTransfers(criteria: object | string, callback: Callback<unknown>): void;
    findClasses(criteria: object | string, callback: Callback<unknown>): void;
    findTaxAgencies(criteria: object | string, callback: Callback<unknown>): void;
    findCompanyInfos(criteria: object | string, callback: Callback<unknown>): void;

    // Create methods
    createBill(bill: object, callback: Callback<unknown>): void;
    createDeposit(deposit: object, callback: Callback<unknown>): void;
    createJournalEntry(journalEntry: object, callback: Callback<unknown>): void;
    createPurchase(purchase: object, callback: Callback<unknown>): void;
    createSalesReceipt(salesReceipt: object, callback: Callback<unknown>): void;
    createInvoice(invoice: object, callback: Callback<unknown>): void;
    createCustomer(customer: object, callback: Callback<unknown>): void;
    createVendorCredit(vendorCredit: object, callback: Callback<unknown>): void;
    createBillPayment(billPayment: object, callback: Callback<unknown>): void;

    // Get methods (single entity by ID)
    getJournalEntry(id: string, callback: Callback<unknown>): void;
    getBill(id: string, callback: Callback<unknown>): void;
    getPurchase(id: string, callback: Callback<unknown>): void;
    getSalesReceipt(id: string, callback: Callback<unknown>): void;
    getInvoice(id: string, callback: Callback<unknown>): void;
    getDeposit(id: string, callback: Callback<unknown>): void;
    getCustomer(id: string, callback: Callback<unknown>): void;
    getVendorCredit(id: string, callback: Callback<unknown>): void;
    getBillPayment(id: string, callback: Callback<unknown>): void;

    // Update methods
    updateJournalEntry(journalEntry: object, callback: Callback<unknown>): void;
    updateBill(bill: object, callback: Callback<unknown>): void;
    updatePurchase(purchase: object, callback: Callback<unknown>): void;
    updateSalesReceipt(salesReceipt: object, callback: Callback<unknown>): void;
    updateInvoice(invoice: object, callback: Callback<unknown>): void;
    updateDeposit(deposit: object, callback: Callback<unknown>): void;
    updateCustomer(customer: object, callback: Callback<unknown>): void;
    updateVendorCredit(vendorCredit: object, callback: Callback<unknown>): void;

    // Delete methods
    deleteJournalEntry(idOrEntity: object | string, callback: Callback<unknown>): void;
    deleteBill(idOrEntity: object | string, callback: Callback<unknown>): void;
    deleteInvoice(idOrEntity: object | string, callback: Callback<unknown>): void;
    deleteDeposit(idOrEntity: object | string, callback: Callback<unknown>): void;
    deleteSalesReceipt(idOrEntity: object | string, callback: Callback<unknown>): void;
    deletePurchase(idOrEntity: object | string, callback: Callback<unknown>): void;
    deleteVendorCredit(idOrEntity: object | string, callback: Callback<unknown>): void;
    deleteBillPayment(idOrEntity: object | string, callback: Callback<unknown>): void;

    // Reports
    reportBalanceSheet(options: object, callback: Callback<unknown>): void;
    reportProfitAndLoss(options: object, callback: Callback<unknown>): void;
    reportProfitAndLossDetail(options: object, callback: Callback<unknown>): void;
    reportTrialBalance(options: object, callback: Callback<unknown>): void;
    reportCashFlow(options: object, callback: Callback<unknown>): void;
    reportCustomerSales(options: object, callback: Callback<unknown>): void;
    reportCustomerBalance(options: object, callback: Callback<unknown>): void;
    reportAgedReceivables(options: object, callback: Callback<unknown>): void;
    reportAgedPayables(options: object, callback: Callback<unknown>): void;
    reportVendorBalance(options: object, callback: Callback<unknown>): void;
    reportGeneralLedgerDetail(options: object, callback: Callback<unknown>): void;
    reportTransactionList(options: object, callback: Callback<unknown>): void;
  }

  export = QuickBooks;
}
