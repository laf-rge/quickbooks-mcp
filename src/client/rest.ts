// Raw QuickBooks REST access for entities node-quickbooks does not wrap.
//
// node-quickbooks declares one prototype method per entity and keeps its generic
// CRUD/query helpers on the CommonJS `module` object rather than `module.exports`,
// so any entity it omits is unreachable through the client. Six queryable
// entities fall in that gap: CreditCardPayment, InventoryAdjustment,
// RecurringTransaction, ReimburseCharge, TaxClassification, TaxPayment.
//
// Errors reject with the parsed QBO `Fault` body rather than a generic Error, so
// isQBError/isAuthError still recognize them and the auth-retry dispatcher in
// tools/index.ts keeps working for these calls too.

import QuickBooks from "node-quickbooks";

// Truncation cap for error text we surface from a non-JSON or unfaulted failure.
const ERROR_BODY_CHARS = 500;

function buildUrl(client: QuickBooks, path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  // client.endpoint already ends in ".../v3/company/"
  return `${client.endpoint}${client.realmId}${path}${sep}minorversion=${client.minorversion}`;
}

/**
 * Issue a request against the QuickBooks v3 REST API using the client's own
 * token, realm, and minor version.
 */
export async function qboRequest<T>(
  client: QuickBooks,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  const hasBody = body !== undefined;

  const response = await fetch(buildUrl(client, path), {
    method,
    headers: {
      Authorization: `Bearer ${client.token}`,
      Accept: "application/json",
      ...(hasBody && { "Content-Type": "application/json" }),
    },
    ...(hasBody && { body: JSON.stringify(body) }),
  });

  const text = await response.text();

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `QuickBooks returned non-JSON (HTTP ${response.status}): ${text.slice(0, ERROR_BODY_CHARS)}`
    );
  }

  const fault = (parsed as { Fault?: unknown }).Fault;
  if (fault) throw parsed;

  if (!response.ok) {
    // A 401 can come back without a Fault body. Synthesize one so isAuthError
    // sees it and executeTool retries with refreshed credentials.
    if (response.status === 401) {
      throw { Fault: { Error: [{ Message: "Unauthorized", code: "401" }], type: "AUTHENTICATION" } };
    }
    throw new Error(
      `QuickBooks request failed (HTTP ${response.status}): ${text.slice(0, ERROR_BODY_CHARS)}`
    );
  }

  return parsed as T;
}

/**
 * Run a query statement through the REST query endpoint. Mirrors what
 * node-quickbooks' find* methods do internally (`select * from <entity> <criteria>`),
 * for entities that have no find* method.
 */
export async function qboQuery<T>(client: QuickBooks, selectStatement: string): Promise<T> {
  return qboRequest<T>(client, "GET", `/query?query=${encodeURIComponent(selectStatement)}`);
}
