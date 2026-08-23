// Entity (name-list) reference resolution for transaction lines and headers.
//
// "Which vendor/customer/employee is this line attributed to" is one idea in the
// QBO UI and four different field shapes in the API. Handlers should not each
// rediscover that, so the resolution lives here and the shape adapters sit next
// to it:
//
//   Deposit line   DepositLineDetail.Entity
//                  → { value, name, type: "VENDOR" }        ReferenceType, type UPPERCASE
//   Journal line   JournalEntryLineDetail.Entity
//                  → { Type: "Vendor", EntityRef: { value, name } }  nested, Type PascalCase
//   Expense header Purchase.EntityRef
//                  → { value, name, type: "Vendor" }        ReferenceType, type PascalCase
//   Expense line   AccountBasedExpenseLineDetail.CustomerRef
//                  → { value, name }                        Customer only, no type at all
//
// The casing differences are not a guess: deposit lines round-trip an uppercase
// type, journal entries use a nested Type/EntityRef pair, and Purchase headers
// use PascalCase. Sending the wrong form is how a line silently comes back with
// a blank name.

import QuickBooks from "node-quickbooks";
import { getVendorCache, getEmployeeCache, resolveCustomer } from "./cache.js";
import { resolveVendorRef, resolveEmployeeRef, normalizeEntityKind } from "./refs.js";
import type { EntityKind, ResolvedEntityRef } from "./refs.js";

// Resolve a name or id against the name list for `kind`.
//
// Vendors and employees come from bulk caches (small lists, partial matching
// across the whole set); customers are looked up lazily by query, because a
// company can have thousands and bulk-loading them on every write would be
// wasteful. All three accept an internal Id, an exact display name, or a partial
// display name, in that precedence.
export async function resolveEntityRef(
  client: QuickBooks,
  nameOrId: string,
  kind: EntityKind
): Promise<ResolvedEntityRef> {
  switch (kind) {
    case "Vendor": {
      const cache = await getVendorCache(client);
      return { ...resolveVendorRef(cache, nameOrId), type: "Vendor" };
    }
    case "Employee": {
      const cache = await getEmployeeCache(client);
      return { ...resolveEmployeeRef(cache, nameOrId), type: "Employee" };
    }
    case "Customer": {
      const ref = await resolveCustomer(client, nameOrId);
      return { ...ref, type: "Customer" };
    }
  }
}

// AccountBasedExpenseLineDetail.CustomerRef holds a customer and nothing else,
// so callers on that path have no kind to choose — this drops the type the
// generic resolver carries and hands back the bare ref QBO expects.
export async function resolveCustomerRef(
  client: QuickBooks,
  nameOrId: string
): Promise<{ value: string; name: string }> {
  const { value, name } = await resolveEntityRef(client, nameOrId, "Customer");
  return { value, name };
}

// --- Tool input adapters ---

// What a handler gets from an entity/customer parameter pair. Three outcomes,
// and every write path has to tell them apart:
//
//   undefined — no input at all; leave whatever the line already carries. This
//               is what keeps `line_id` preserving an existing entity.
//   null      — an explicitly empty name; remove the entity from the line.
//   ref       — a resolved entity to write.
//
// Collapsing "absent" into "empty" is the bug this type exists to prevent: it
// would silently strip the vendor off every line an edit merely reprices.
export type EntityInputResult<T> = T | null | undefined;

export interface EntityLineInput {
  entity_name?: string;
  entity_id?: string;
  entity_type?: string;
}

export interface CustomerLineInput {
  customer_name?: string;
  customer_id?: string;
}

// Errors are re-thrown with the caller's label so "Vendor not found" says which
// line it came from.
function withLabel(label: string, err: unknown): Error {
  return new Error(`${label}: ${(err as Error).message}`);
}

// Resolve an entity_name/entity_id/entity_type triple. entity_type defaults to
// Vendor, which is what every tool that predates the parameter assumed.
export async function resolveEntityInput(
  client: QuickBooks,
  input: EntityLineInput,
  label: string
): Promise<EntityInputResult<ResolvedEntityRef>> {
  const raw = input.entity_id ?? input.entity_name;
  if (raw === undefined) return undefined;
  if (raw.trim() === "") return null;
  try {
    return await resolveEntityRef(client, raw, normalizeEntityKind(input.entity_type));
  } catch (err) {
    throw withLabel(label, err);
  }
}

// Resolve a customer_name/customer_id pair for the line details that accept a
// customer and nothing else.
export async function resolveCustomerInput(
  client: QuickBooks,
  input: CustomerLineInput,
  label: string
): Promise<EntityInputResult<{ value: string; name: string }>> {
  const raw = input.customer_id ?? input.customer_name;
  if (raw === undefined) return undefined;
  if (raw.trim() === "") return null;
  try {
    return await resolveCustomerRef(client, raw);
  } catch (err) {
    throw withLabel(label, err);
  }
}

// --- Shape adapters ---

// Deposit lines: a flat ReferenceType whose `type` QBO round-trips uppercased.
export function toDepositEntity(ref: ResolvedEntityRef): {
  value: string;
  name: string;
  type: string;
} {
  return { value: ref.value, name: ref.name, type: ref.type.toUpperCase() };
}

// Journal entry lines: Type sits beside a nested EntityRef rather than inside
// it. Note QBO *requires* this on lines posting to A/R or A/P — a receivable
// line with no customer is rejected outright.
export function toJournalEntryEntity(ref: ResolvedEntityRef): {
  Type: EntityKind;
  EntityRef: { value: string; name: string };
} {
  return { Type: ref.type, EntityRef: { value: ref.value, name: ref.name } };
}

// Purchase (expense) header payee: a flat ReferenceType with a PascalCase type.
export function toPurchaseEntityRef(ref: ResolvedEntityRef): {
  value: string;
  name: string;
  type: EntityKind;
} {
  return { value: ref.value, name: ref.name, type: ref.type };
}
