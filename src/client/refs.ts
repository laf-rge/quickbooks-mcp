// Shared reference resolvers for entity handlers.
//
// Handlers turn user-supplied names/numbers into QBO ref objects ({ value, name })
// before building a transaction. That resolution chain — and, just as importantly,
// its precedence and error text — used to be copy-pasted into every create and
// edit path, so "what counts as a match" drifted per handler. It lives here now.
//
// These are synchronous and take an already-loaded cache, because handlers
// resolve several refs against caches they fetched together in one Promise.all.
// The async, client-taking `resolveAccount`/`resolveVendor` in cache.ts remain
// for callers that only need a single lookup; note `resolveAccount` matches on
// internal Id first, which the handler chain deliberately does not (handlers take
// account_id as its own parameter).

import type { AccountCache, VendorCache, EmployeeCache, CachedAccount } from "../types/index.js";

// QBO ref shape. Accounts carry AcctNum along because callers echo it back in
// their reports.
export interface AccountRef {
  value: string;
  name: string;
  acctNum?: string;
}

export interface VendorRef {
  value: string;
  name: string;
}

// The three name-list types QBO will accept as the entity on a transaction line.
// Item and Account are refs of their own and never appear here.
export type EntityKind = "Vendor" | "Customer" | "Employee";

export const ENTITY_KINDS: EntityKind[] = ["Vendor", "Customer", "Employee"];

// A resolved entity, carrying the kind it was resolved as. The kind has to
// travel with the ref because the id alone is ambiguous — vendor 42 and
// customer 42 are different records, and QBO reads the type to tell them apart.
export interface ResolvedEntityRef {
  value: string;
  name: string;
  type: EntityKind;
}

// Accept an entity type in any casing ("vendor", "VENDOR") and return the
// canonical form. Callers pass a fallback for the kind to assume when the
// parameter is omitted; every existing tool defaults to Vendor, which is what
// its behaviour was before entity_type existed.
export function normalizeEntityKind(
  input: string | undefined,
  fallback: EntityKind = "Vendor"
): EntityKind {
  if (input === undefined) return fallback;
  const match = ENTITY_KINDS.find(k => k.toLowerCase() === input.trim().toLowerCase());
  if (!match) {
    throw new Error(
      `Invalid entity_type: "${input}". Must be one of: ${ENTITY_KINDS.join(", ")}`
    );
  }
  return match;
}

export interface ResolveAccountOptions {
  // Noun for the not-found error, e.g. "Payment account" → `Payment account not
  // found: "..."`. Defaults to "Account".
  label?: string;
  // Restrict candidates to a QBO AccountType (e.g. "Bank"). Without it a partial
  // match can land on any account that merely shares digits or words with the
  // input, which matters most for tools that move money.
  accountType?: string;
}

// Match precedence: exact AcctNum, then exact Name, then partial
// FullyQualifiedName. Both exact forms are checked before any partial match so a
// precise input can never be beaten by a loose substring hit on another account.
function findAccount(
  cache: AccountCache,
  key: string,
  accountType?: string
): CachedAccount | undefined {
  if (!accountType) {
    // Fast path: the cache's prebuilt indexes already key on lowercased AcctNum
    // and Name.
    return (
      cache.byAcctNum.get(key) ??
      cache.byName.get(key) ??
      cache.items.find(a => a.FullyQualifiedName?.toLowerCase().includes(key))
    );
  }

  // Filtered path: the prebuilt indexes span every type, so walk a restricted
  // pool while keeping the same precedence.
  const pool = cache.items.filter(a => a.AccountType === accountType);
  return (
    pool.find(a => a.AcctNum?.toLowerCase() === key) ??
    pool.find(a => a.Name.toLowerCase() === key) ??
    pool.find(a => a.FullyQualifiedName?.toLowerCase().includes(key))
  );
}

// Resolve an account by number, name, or partial FullyQualifiedName.
// Throws when nothing matches — callers treat an unresolvable account as fatal
// rather than posting a transaction to the wrong place.
export function resolveAccountRef(
  cache: AccountCache,
  nameOrNumber: string,
  opts: ResolveAccountOptions = {}
): AccountRef {
  const { label = "Account", accountType } = opts;
  const match = findAccount(cache, nameOrNumber.toLowerCase(), accountType);

  if (!match) {
    if (accountType) {
      throw new Error(
        `${label} not found: "${nameOrNumber}". No ${accountType}-type account matches.`
      );
    }
    throw new Error(`${label} not found: "${nameOrNumber}"`);
  }

  return {
    value: match.Id,
    name: match.FullyQualifiedName || match.Name,
    acctNum: match.AcctNum,
  };
}

// Narrow a resolved ref to just the fields QBO accepts on a ReferenceType.
// resolveAccountRef carries acctNum for callers that echo it into reports; that
// field must not ride along into a request payload.
export function toQboRef(ref: AccountRef | VendorRef): { value: string; name: string } {
  return { value: ref.value, name: ref.name };
}

// Resolve a vendor by internal Id, exact DisplayName, or partial DisplayName.
export function resolveVendorRef(cache: VendorCache, nameOrId: string): VendorRef {
  const byId = cache.byId.get(nameOrId);
  if (byId) return { value: byId.Id, name: byId.DisplayName };

  const key = nameOrId.toLowerCase();

  const byName = cache.byName.get(key);
  if (byName) return { value: byName.Id, name: byName.DisplayName };

  const byPartial = cache.items.find(v => v.DisplayName.toLowerCase().includes(key));
  if (byPartial) return { value: byPartial.Id, name: byPartial.DisplayName };

  throw new Error(`Vendor not found: "${nameOrId}"`);
}

// Resolve an employee by internal Id, exact DisplayName, or partial DisplayName.
// Mirrors resolveVendorRef; employees are bulk-cached for the same reason.
export function resolveEmployeeRef(cache: EmployeeCache, nameOrId: string): VendorRef {
  const byId = cache.byId.get(nameOrId);
  if (byId) return { value: byId.Id, name: byId.DisplayName };

  const key = nameOrId.toLowerCase();

  const byName = cache.byName.get(key);
  if (byName) return { value: byName.Id, name: byName.DisplayName };

  const byPartial = cache.items.find(e => e.DisplayName?.toLowerCase().includes(key));
  if (byPartial) return { value: byPartial.Id, name: byPartial.DisplayName };

  throw new Error(`Employee not found: "${nameOrId}"`);
}
