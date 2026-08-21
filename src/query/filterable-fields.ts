// Filterable fields per QB entity and query error enhancement
//
// QB API only supports filtering on specific fields. AI clients frequently
// attempt to filter on non-filterable fields (DepartmentRef, AccountRef, Line.*),
// which produces opaque errors. This module provides just-in-time guidance
// in error responses.

import { formatQboError } from "../utils/errors.js";

// Fields that can be used in WHERE clauses for each entity type
const FILTERABLE_FIELDS: Record<string, string[]> = {
  Purchase: [
    'TxnDate', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime',
    'DocNumber', 'PaymentType', 'TotalAmt',
  ],
  Deposit: [
    'TxnDate', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime',
    'TotalAmt',
  ],
  JournalEntry: [
    'TxnDate', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime',
    'DocNumber', 'TotalAmt',
  ],
  Bill: [
    'TxnDate', 'DueDate', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime',
    'VendorRef', 'APAccountRef', 'TotalAmt', 'Balance',
  ],
  Invoice: [
    'TxnDate', 'DueDate', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime',
    'CustomerRef', 'DocNumber', 'TotalAmt', 'Balance',
  ],
  SalesReceipt: [
    'TxnDate', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime',
    'CustomerRef', 'DocNumber', 'TotalAmt',
  ],
  Payment: [
    'TxnDate', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime',
    'CustomerRef', 'TotalAmt',
  ],
  CreditCardPayment: [
    'TxnDate', 'VendorRef', 'Id',
  ],
  Customer: [
    'DisplayName', 'GivenName', 'FamilyName', 'CompanyName',
    'PrimaryEmailAddr', 'Active', 'Balance',
    'MetaData.CreateTime', 'MetaData.LastUpdatedTime',
  ],
  Vendor: [
    'DisplayName', 'GivenName', 'FamilyName', 'CompanyName',
    'PrimaryEmailAddr', 'Active', 'Balance',
    'MetaData.CreateTime', 'MetaData.LastUpdatedTime',
  ],
  Account: [
    'Name', 'AccountType', 'AccountSubType', 'Active',
    'Classification', 'MetaData.CreateTime', 'MetaData.LastUpdatedTime',
  ],
  Item: [
    'Name', 'Active', 'Type',
    'MetaData.CreateTime', 'MetaData.LastUpdatedTime',
  ],
  Department: [
    'Name', 'Active',
    'MetaData.CreateTime', 'MetaData.LastUpdatedTime',
  ],
};

// Common non-filterable fields with suggested alternatives
const ALTERNATIVE_SUGGESTIONS: Record<string, string> = {
  DepartmentRef: 'Use the query_account_transactions tool to filter by department.',
  AccountRef: 'Use the query_account_transactions tool to filter by account.',
  'Line': 'Line sub-fields are not filterable. Query by date range, then filter results client-side.',
};

// Regex patterns for detecting bad fields from QB error messages
const BAD_FIELD_PATTERNS = [
  /property name:\s*(\S+)/i,
  /field\s+(\S+)\s+is not/i,
  /(\w+(?:\.\w+)+)\s+is not supported/i,
  /(DepartmentRef|AccountRef|Line\.\w+)/i,
];

/**
 * Build an enhanced error message for query failures, including filterable
 * fields for the entity and alternative tool suggestions when applicable.
 */
export function buildQueryErrorMessage(
  entity: string,
  code?: string,
  message?: string,
  detail?: string,
  rawError?: unknown,
): string {
  const lines: string[] = [];

  // 1. What failed
  lines.push('Query failed');
  if (code) lines[0] += ` (code ${code})`;
  if (message) lines.push(message);
  if (detail) lines.push(detail);

  // 2. Try to identify the bad field from error text
  const errorText = [message, detail].filter(Boolean).join(' ');
  let badField: string | undefined;
  for (const pattern of BAD_FIELD_PATTERNS) {
    const match = errorText.match(pattern);
    if (match) {
      badField = match[1];
      break;
    }
  }

  // 3. Alternative suggestion for the bad field
  if (badField) {
    // Check exact match first, then prefix match (e.g. Line.Something → Line)
    const suggestion = ALTERNATIVE_SUGGESTIONS[badField]
      ?? (badField.startsWith('Line') ? ALTERNATIVE_SUGGESTIONS['Line'] : undefined);
    if (suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${suggestion}`);
    }
  }

  // 4. List valid filterable fields for this entity
  const key = Object.keys(FILTERABLE_FIELDS).find(
    k => k.toLowerCase() === entity.toLowerCase()
  );
  if (key) {
    lines.push('');
    lines.push(`Filterable fields for ${key}:`);
    lines.push(FILTERABLE_FIELDS[key].join(', '));
  }

  // 5. Append raw error if not already covered. formatQboError rather than
  // JSON.stringify: the rejection reaching here is often the axios error, which
  // references its own config and socket and would throw on a bare stringify —
  // turning a query failure into a crash.
  if (rawError && !message && !detail) {
    lines.push('');
    lines.push(`Raw error: ${formatQboError(rawError)}`);
  }

  return lines.join('\n');
}
