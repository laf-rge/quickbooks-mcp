// Handler for query tool

import QuickBooks from "node-quickbooks";
import { getQboUrl, hasQboUrl, outputReport } from "../../utils/index.js";
import {
  parsePaginationFromQuery,
  paginatedQuery,
  fetcherForEntity,
  SAFETY_LIMIT,
  WARNING_THRESHOLD,
  buildQueryErrorMessage,
  summarizeTransactionLines,
} from "../../query/index.js";
import { isQBError, extractQBErrorInfo } from "../../types/index.js";
import { isAuthFault } from "../../utils/errors.js";

export async function handleQuery(
  client: QuickBooks,
  args: { query: string }
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const { query } = args;

  // Parse pagination params from query
  const pagination = parsePaginationFromQuery(query);

  // Determine entity type from query for appropriate finder method
  const entityMatch = query.match(/FROM\s+(\w+)/i);
  if (!entityMatch) {
    throw new Error("Invalid query: must contain FROM clause");
  }

  const entity = entityMatch[1];

  // Handle irregular plurals for finder method names
  const pluralMap: Record<string, string> = {
    'JournalEntry': 'JournalEntries',
    'Company': 'CompanyInfos',
    'Class': 'Classes',
    'TaxAgency': 'TaxAgencies',
  };
  const plural = pluralMap[entity] || `${entity}s`;
  const finderMethod = `find${plural}` as keyof QuickBooks;

  // node-quickbooks only wraps ~35 entities. For the rest (CreditCardPayment,
  // TaxPayment, InventoryAdjustment, RecurringTransaction, ReimburseCharge,
  // TaxClassification) fall back to the raw REST query endpoint, which accepts
  // any queryable entity. An unknown entity name now surfaces QB's own
  // "not found for Entity" fault rather than a hardcoded list.
  const fetcher = fetcherForEntity(client, entity, finderMethod);

  // Execute paginated query with enhanced error handling
  let paginationResult;
  try {
    paginationResult = await paginatedQuery(fetcher, pagination);
  } catch (error) {
    // An expired token is not a query problem. It has to reach executeTool to
    // trigger the credential refresh; answering it with a list of filterable
    // fields would bury the one failure that fixes itself on retry.
    if (isAuthFault(error)) throw error;

    // QB query errors (non-filterable fields, bad syntax) get enhanced messages.
    // The fault is found wherever it sits: through a node-quickbooks find*
    // method it arrives nested on the axios rejection, not at the top level.
    if (isQBError(error)) {
      const { code, message, detail } = extractQBErrorInfo(error);
      const errorMessage = buildQueryErrorMessage(entity, code, message, detail, error);
      return {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      };
    }
    // Non-QB errors (auth, network) re-throw for executeTool to handle
    throw error;
  }

  let { entities } = paginationResult;
  const { entityKey, apiCalls, truncated, startPositionSpecified, hasMore, returnedCount, requestedLimit } = paginationResult;
  const count = entities.length;

  // Add QBO links for entities with a confirmed QBO app route (see utils/urls.ts)
  const isLinkable = hasQboUrl(entity);

  if (isLinkable && entities.length > 0) {
    entities = entities.map((record) => ({
      ...record,
      QboLink: record.Id ? getQboUrl(entity, record.Id) : null
    }));
  }

  // Build result object for file output
  const result = {
    QueryResponse: {
      [entityKey]: entities
    }
  };

  // Build summary with pagination status
  const summaryLines = [
    `Query: ${entity}`,
    `Results: ${count} records${isLinkable ? ' (with QBO links)' : ''}`
  ];

  // Add pagination info
  if (startPositionSpecified) {
    summaryLines.push('Note: STARTPOSITION specified - no auto-pagination');
  } else if (apiCalls > 1) {
    summaryLines.push(`Fetched in ${apiCalls} API calls`);
  }

  // Add warnings and "more data" guidance
  if (truncated) {
    summaryLines.push(`Warning: Results truncated at ${SAFETY_LIMIT} records (safety limit)`);
  } else if (hasMore) {
    summaryLines.push(`Note: Results limited to ${requestedLimit} by MAXRESULTS. More data exists.`);
    const nextPosition = (startPositionSpecified ? (pagination.startPosition || 1) : 1) + returnedCount;
    summaryLines.push(`To fetch more: Add "STARTPOSITION ${nextPosition}" to query.`);
  } else if (count >= WARNING_THRESHOLD) {
    summaryLines.push(`Warning: Large result set (>${WARNING_THRESHOLD} records)`);
  }

  const txnSummary = summarizeTransactionLines(entity, entities);
  if (txnSummary) {
    summaryLines.push('');
    summaryLines.push(txnSummary);
  }

  return outputReport(`query-${entity.toLowerCase()}`, result, summaryLines.join("\n"));
}
