// Handler for query_account_transactions tool

import QuickBooks from "node-quickbooks";
import {
  resolveAccount,
  getDepartmentCache,
  getAccountCache,
  collectAccountTree,
} from "../../client/index.js";
import { toCents, sumCents, toDollars, outputReport, isHttpMode, mapWithConcurrency } from "../../utils/index.js";
import { PaginationParams } from "../../types/index.js";
import { paginatedQuery, fetcherForEntity, extractAccountLines } from "../../query/index.js";
import { TransactionLine } from "../../types/index.js";

// Default window size in HTTP mode, in transactions. HTTP has no filesystem, so
// the detail goes straight into the model's context and must be bounded; stdio
// writes to a temp file and defaults to the full result set. Sized so a typical
// page stays close to the inline payload the previous 100-line cap produced.
const HTTP_DEFAULT_LIMIT = 50;

// Entity queries in flight at once. Intuit throttles per realm, and each of
// these auto-paginates, so the real request count is higher than the entity
// count. Low enough to stay under the limit, high enough that the drill-down
// still completes promptly.
const ENTITY_QUERY_CONCURRENCY = 4;

// Every QBO entity that posts to an account and exposes the account as a
// reference in its JSON. `finder` is the node-quickbooks wrapper method; where
// none exists the raw REST query endpoint is used instead (fetcherForEntity).
//
// Deliberately excluded:
//   Estimate, PurchaseOrder, TimeActivity  — non-posting
//   RecurringTransaction                   — a template, not a posting txn
//   TaxPayment, InventoryAdjustment,
//   ReimburseCharge                        — posting, but line shapes unverified
//
// Note that an entity appearing here does not make every side of it visible:
// A/R has no ARAccountRef on Invoice, CreditMemo, or Payment, and sales tax
// posts through TxnTaxDetail with no AccountRef. Those postings cannot be
// recovered from entity JSON at all — see docs/entity-coverage.md.
const POSTING_ENTITIES: Array<{ type: string; finder: string }> = [
  { type: 'JournalEntry', finder: 'findJournalEntries' },
  { type: 'Purchase', finder: 'findPurchases' },
  { type: 'Deposit', finder: 'findDeposits' },
  { type: 'SalesReceipt', finder: 'findSalesReceipts' },
  { type: 'Bill', finder: 'findBills' },
  { type: 'Invoice', finder: 'findInvoices' },
  { type: 'Payment', finder: 'findPayments' },
  { type: 'BillPayment', finder: 'findBillPayments' },
  { type: 'VendorCredit', finder: 'findVendorCredits' },
  { type: 'Transfer', finder: 'findTransfers' },
  { type: 'CreditMemo', finder: 'findCreditMemos' },
  { type: 'RefundReceipt', finder: 'findRefundReceipts' },
  // No node-quickbooks wrapper — reached via raw REST
  { type: 'CreditCardPayment', finder: 'findCreditCardPayments' },
];

// Group transactions by unique transaction key (type:txnId)
interface GroupedTransaction {
  type: string;
  txnId: string;
  docNumber?: string;
  date: string;
  department?: string;
  qboLink: string;
  lines: TransactionLine[];
}

function groupTransactionLines(lines: TransactionLine[]): GroupedTransaction[] {
  const groups = new Map<string, GroupedTransaction>();

  for (const line of lines) {
    const key = `${line.type}:${line.txnId}`;

    if (!groups.has(key)) {
      groups.set(key, {
        type: line.type,
        txnId: line.txnId,
        docNumber: line.docNumber,
        date: line.date,
        department: line.department,
        qboLink: line.qboLink,
        lines: []
      });
    }

    groups.get(key)!.lines.push(line);
  }

  // Convert to array and sort by date
  const result = Array.from(groups.values());
  result.sort((a, b) => a.date.localeCompare(b.date));

  return result;
}

export async function handleQueryAccountTransactions(
  client: QuickBooks,
  args: {
    account: string;
    start_date?: string;
    end_date?: string;
    department?: string;
    offset?: number;
    limit?: number;
    include_subaccounts?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { account, start_date, end_date, department, offset = 0, limit, include_subaccounts = false } = args;

  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`offset must be a non-negative integer, got ${offset}`);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`limit must be a positive integer, got ${limit}`);
  }

  // Resolve account using cache
  const resolvedAccount = await resolveAccount(client, account);

  // Get account cache for name lookups
  const accountCache = await getAccountCache(client);

  // Which AccountRefs count as a hit. Entity reads match one account by default;
  // opting in to sub-accounts makes this agree with account_period_summary,
  // whose General Ledger report rolls the subtree into the parent.
  const wholeTree = collectAccountTree(accountCache, resolvedAccount.Id);
  const subAccountIds = [...wholeTree].filter(id => id !== resolvedAccount.Id);
  const targetAccountIds: ReadonlySet<string> = include_subaccounts
    ? wholeTree
    : new Set([resolvedAccount.Id]);

  // Resolve department if provided using cache
  let resolvedDepartmentId: string | undefined;
  let resolvedDepartmentName: string | undefined;
  if (department) {
    const deptCache = await getDepartmentCache(client);

    // Try exact ID match
    let deptMatch = deptCache.byId.get(department);

    // Try exact name match (case-insensitive)
    if (!deptMatch) {
      deptMatch = deptCache.byName.get(department.toLowerCase());
    }

    // Try partial match on FullyQualifiedName
    if (!deptMatch) {
      deptMatch = deptCache.items.find(d =>
        d.FullyQualifiedName?.toLowerCase().includes(department.toLowerCase())
      );
    }

    if (deptMatch) {
      resolvedDepartmentId = deptMatch.Id;
      resolvedDepartmentName = deptMatch.Name;
    } else {
      throw new Error(`Department not found: "${department}"`);
    }
  }

  // Build date range
  const today = new Date().toISOString().split('T')[0];
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const startDateResolved = start_date || yearStart;
  const endDateResolved = end_date || today;

  // Build date filter for QB query
  const dateFilter = `TxnDate >= '${startDateResolved}' AND TxnDate <= '${endDateResolved}'`;

  // Query the entity types with bounded parallelism. Firing all 13 at once
  // reliably trips Intuit's per-realm throttle, and a throttled entity comes
  // back empty — which in a drill-down reads as "no activity on this account"
  // rather than "ask again". Retry lives in the fetcher; this keeps us from
  // needing it in the first place.
  const queryResults = await mapWithConcurrency(
    POSTING_ENTITIES,
    ENTITY_QUERY_CONCURRENCY,
    async ({ type, finder }) => {
      const pagination: PaginationParams = {
        maxResults: 10000,  // Use full SAFETY_LIMIT for account transaction queries
        startPosition: null, // Auto-paginate
        baseCriteria: `WHERE ${dateFilter}`
      };
      try {
        const fetcher = fetcherForEntity(client, type, finder as keyof QuickBooks);
        const result = await paginatedQuery(fetcher, pagination);
        return { type, entities: result.entities as Array<Record<string, unknown>>, failed: false };
      } catch {
        // An entity type can fail on its own (permissions, unsupported in this
        // company's region). Keep going, but report it rather than silently
        // returning an incomplete drill-down.
        return { type, entities: [], failed: true };
      }
    }
  );

  const failedTypes = queryResults.filter(r => r.failed).map(r => r.type);

  // Extract lines matching the account from each entity type
  const allLines: TransactionLine[] = [];
  for (const { type, entities } of queryResults) {
    const lines = extractAccountLines(
      entities,
      type,
      targetAccountIds,
      accountCache,
      resolvedDepartmentId
    );
    allLines.push(...lines);
  }

  // Sort by date (oldest first)
  allLines.sort((a, b) => a.date.localeCompare(b.date));

  // Group lines by transaction
  const groupedTransactions = groupTransactionLines(allLines);

  // Calculate summary stats using cents for precision
  // Only count matching lines for summary (avoid double-counting)
  const matchingLines = allLines.filter(l => l.isMatchingLine);
  const totalDebitsCents = sumCents(
    matchingLines.filter(l => l.amount > 0).map(l => toCents(l.amount))
  );
  const totalCreditsCents = sumCents(
    matchingLines.filter(l => l.amount < 0).map(l => toCents(Math.abs(l.amount)))
  );
  const netChangeCents = totalDebitsCents - totalCreditsCents;

  // Convert back to dollars for display/storage
  const totalDebits = toDollars(totalDebitsCents);
  const totalCredits = toDollars(totalCreditsCents);
  const netChange = toDollars(netChangeCents);

  // Build report data with grouped view
  const groupedByTransaction: Record<string, {
    type: string;
    docNumber?: string;
    date: string;
    department?: string;
    qboLink: string;
    lines: Array<{
      lineId: string;
      accountId: string;
      accountName: string;
      amount: number;
      description?: string;
      isMatchingLine: boolean;
    }>;
  }> = {};

  for (const txn of groupedTransactions) {
    const key = `${txn.type}:${txn.txnId}`;
    groupedByTransaction[key] = {
      type: txn.type,
      docNumber: txn.docNumber,
      date: txn.date,
      department: txn.department,
      qboLink: txn.qboLink,
      lines: txn.lines.map(l => ({
        lineId: l.lineId,
        accountId: l.accountId,
        accountName: l.accountName,
        amount: l.amount,
        description: l.description,
        isMatchingLine: l.isMatchingLine
      }))
    };
  }

  // Window over whole transactions, never lines, so a page boundary can't split
  // a journal entry in half. Summary stats above are always computed from the
  // full result set, so totals stay correct no matter which window is returned.
  const totalTransactions = groupedTransactions.length;
  const windowOffset = Math.min(offset, totalTransactions);
  const windowLimit = limit ?? (isHttpMode() ? HTTP_DEFAULT_LIMIT : totalTransactions);
  const windowTxns = groupedTransactions.slice(windowOffset, windowOffset + windowLimit);
  const nextOffset = windowOffset + windowTxns.length;
  const hasMore = nextOffset < totalTransactions;

  const windowKeys = new Set(windowTxns.map(t => `${t.type}:${t.txnId}`));
  const outputLines = allLines.filter(l => windowKeys.has(`${l.type}:${l.txnId}`));
  const outputGrouped: typeof groupedByTransaction = {};
  for (const txn of windowTxns) {
    const key = `${txn.type}:${txn.txnId}`;
    outputGrouped[key] = groupedByTransaction[key];
  }

  const reportData = {
    account: {
      id: resolvedAccount.Id,
      includedSubAccountIds: include_subaccounts ? subAccountIds : [],
      acctNum: resolvedAccount.AcctNum,
      name: resolvedAccount.FullyQualifiedName || resolvedAccount.Name,
      type: resolvedAccount.AccountType,
      currentBalance: resolvedAccount.CurrentBalance
    },
    dateRange: {
      start: startDateResolved,
      end: endDateResolved
    },
    department: resolvedDepartmentId ? {
      id: resolvedDepartmentId,
      name: resolvedDepartmentName
    } : undefined,
    summary: {
      transactionCount: groupedTransactions.length,
      matchingLineCount: matchingLines.length,
      totalDebits,
      totalCredits,
      netChange
    },
    // The scanned list is auditable but static — free in a stdio temp file,
    // pure context cost inline in HTTP mode. Failures are always reported,
    // since they mean the result is actually incomplete.
    coverage: {
      ...(isHttpMode() ? {} : { scannedEntityTypes: POSTING_ENTITIES.map(e => e.type) }),
      ...(failedTypes.length > 0 ? { failedEntityTypes: failedTypes } : {}),
    },
    pagination: {
      offset: windowOffset,
      limit: windowLimit,
      returnedTransactions: windowTxns.length,
      totalTransactions,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
    },
    transactions: outputLines,
    groupedByTransaction: outputGrouped,
  };

  // Build summary for display
  const formatCurrency = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const summaryLines = [
    'Account Transaction Query',
    '=========================',
    `Account: ${resolvedAccount.AcctNum ? `${resolvedAccount.AcctNum} ` : ''}${resolvedAccount.FullyQualifiedName || resolvedAccount.Name} (${resolvedAccount.AccountType})`,
    `Period: ${startDateResolved} to ${endDateResolved}`,
  ];

  if (resolvedDepartmentName) {
    summaryLines.push(`Department: ${resolvedDepartmentName}`);
  }

  // Say which accounts were actually matched. Without this, a parent account
  // that holds no postings of its own looks empty while account_period_summary
  // reports plenty — the single most confusing disagreement between the two.
  if (subAccountIds.length > 0) {
    const names = subAccountIds
      .map(id => accountCache.byId.get(id))
      .map(a => (a?.AcctNum ? `${a.AcctNum} ${a.Name}` : a?.Name))
      .filter(Boolean);
    summaryLines.push(
      include_subaccounts
        ? `Including ${subAccountIds.length} sub-account(s): ${names.join(', ')}`
        : `Note: this account has ${subAccountIds.length} sub-account(s) — ${names.join(', ')} — whose transactions are NOT included. Pass include_subaccounts=true to include them (account_period_summary always rolls them up).`
    );
  }

  summaryLines.push('');
  summaryLines.push(`Summary: ${groupedTransactions.length} transactions | Debits: ${formatCurrency(totalDebits)} | Credits: ${formatCurrency(totalCredits)} | Net: ${netChange >= 0 ? '' : '-'}${formatCurrency(netChange)}`);

  if (windowTxns.length === 0 && windowOffset > 0) {
    summaryLines.push(`No transactions at offset ${windowOffset} — the period has ${totalTransactions}.`);
  } else if (windowTxns.length < totalTransactions) {
    summaryLines.push(
      `Showing transactions ${windowOffset + 1}-${nextOffset} of ${totalTransactions} in detail.`
    );
    if (hasMore) {
      summaryLines.push(`To fetch more: call again with offset=${nextOffset}.`);
    }
  }

  if (failedTypes.length > 0) {
    summaryLines.push(`Warning: could not query ${failedTypes.join(', ')} — results may be incomplete.`);
  }

  // Invoice, CreditMemo, and Payment carry no ARAccountRef, so their A/R side is
  // absent from the entity JSON entirely. A short result on an A/R account is
  // therefore not proof of no activity.
  if (resolvedAccount.AccountType === 'Accounts Receivable') {
    summaryLines.push(
      'Note: the A/R side of Invoice, CreditMemo, and Payment has no ARAccountRef in ' +
      'QBO entity JSON and cannot appear here. Use account_period_summary, which reads ' +
      'the General Ledger report, for a complete figure.'
    );
  }

  // Preview the returned window, not the full set — otherwise every page of a
  // paginated walk shows the same five transactions.
  if (windowTxns.length > 0) {
    summaryLines.push('');
    summaryLines.push(`Preview (first 5 of this page):`);
    summaryLines.push('');

    for (const txn of windowTxns.slice(0, 5)) {
      const docNum = txn.docNumber ? ` #${txn.docNumber}` : '';
      const dept = txn.department ? ` [${txn.department}]` : '';

      // Calculate total for transaction (sum of absolute values / 2 for balanced transactions)
      const txnDebits = txn.lines.filter(l => l.amount > 0).reduce((sum, l) => sum + l.amount, 0);

      summaryLines.push(`${txn.type}${docNum} (${txn.date}) - ${formatCurrency(txnDebits)} total${dept}`);

      // Show all lines with arrow for matching lines
      for (const line of txn.lines) {
        const indicator = line.isMatchingLine ? '→' : ' ';
        const amountStr = line.amount >= 0
          ? `${formatCurrency(line.amount).padStart(12)}  debit`
          : `${formatCurrency(line.amount).padStart(12)}  credit`;
        const desc = line.description ? `  ${line.description.substring(0, 25)}${line.description.length > 25 ? '...' : ''}` : '';
        summaryLines.push(`  ${indicator} ${line.accountName.padEnd(28)} ${amountStr}${desc}`);
      }
      summaryLines.push('');
    }
  }

  return outputReport('account-transactions', reportData, summaryLines.join('\n'));
}
