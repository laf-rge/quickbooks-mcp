// Account and department caching for QuickBooks lookups

import QuickBooks from "node-quickbooks";
import { promisify } from "./promisify.js";
import {
  CachedAccount,
  CachedCustomer,
  CachedClass,
  CachedDepartment,
  CachedVendor,
  CachedEmployee,
  CachedItem,
  AccountCache,
  ClassCache,
  DepartmentCache,
  VendorCache,
  EmployeeCache,
  QBQueryResponse,
} from "../types/index.js";

// Cache TTL (15 minutes)
const LOOKUP_CACHE_TTL_MS = 15 * 60 * 1000;

// Module-level cache state
let departmentCache: DepartmentCache | null = null;
let classCache: ClassCache | null = null;
let accountCache: AccountCache | null = null;
let vendorCache: VendorCache | null = null;
let employeeCache: EmployeeCache | null = null;
// Item cache: lazy per-entry lookup (not bulk-loaded like others)
const itemCacheById = new Map<string, CachedItem>();
const itemCacheByName = new Map<string, CachedItem>(); // lowercase key
// Customer cache: lazy per-entry lookup (companies can have thousands)
const customerCacheById = new Map<string, CachedCustomer>();
const customerCacheByName = new Map<string, CachedCustomer>(); // lowercase key

export function clearLookupCache(): void {
  departmentCache = null;
  classCache = null;
  accountCache = null;
  vendorCache = null;
  employeeCache = null;
  itemCacheById.clear();
  itemCacheByName.clear();
  customerCacheById.clear();
  customerCacheByName.clear();
}

// Helper to extract entities from QB query response with type safety
function extractQueryResults<T>(result: unknown, entityKey: string): T[] {
  const response = result as QBQueryResponse<T> | undefined;
  const entities = response?.QueryResponse?.[entityKey];
  return Array.isArray(entities) ? entities : [];
}

export async function getDepartmentCache(client: QuickBooks): Promise<DepartmentCache> {
  if (departmentCache && (Date.now() - departmentCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return departmentCache;
  }

  const result = await promisify<unknown>((cb) => client.findDepartments({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedDepartment>(result, 'Department');

  const byId = new Map<string, CachedDepartment>();
  const byName = new Map<string, CachedDepartment>();
  for (const dept of items) {
    byId.set(dept.Id, dept);
    byName.set(dept.Name.toLowerCase(), dept);
  }

  departmentCache = { items, byId, byName, fetchedAt: Date.now() };
  return departmentCache;
}

export async function getClassCache(client: QuickBooks): Promise<ClassCache> {
  if (classCache && (Date.now() - classCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return classCache;
  }

  const result = await promisify<unknown>((cb) => client.findClasses({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedClass>(result, 'Class');

  const byId = new Map<string, CachedClass>();
  const byName = new Map<string, CachedClass>();
  for (const cls of items) {
    byId.set(cls.Id, cls);
    // Index by both the leaf Name and the FullyQualifiedName ("Parent:Child") so
    // nested classes resolve by either form.
    byName.set(cls.Name.toLowerCase(), cls);
    if (cls.FullyQualifiedName) {
      byName.set(cls.FullyQualifiedName.toLowerCase(), cls);
    }
  }

  classCache = { items, byId, byName, fetchedAt: Date.now() };
  return classCache;
}

export async function getAccountCache(client: QuickBooks): Promise<AccountCache> {
  if (accountCache && (Date.now() - accountCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return accountCache;
  }

  const result = await promisify<unknown>((cb) => client.findAccounts({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedAccount>(result, 'Account');

  const byId = new Map<string, CachedAccount>();
  const byName = new Map<string, CachedAccount>();
  const byAcctNum = new Map<string, CachedAccount>();
  for (const acct of items) {
    byId.set(acct.Id, acct);
    byName.set(acct.Name.toLowerCase(), acct);
    if (acct.AcctNum) {
      byAcctNum.set(acct.AcctNum.toLowerCase(), acct);
    }
  }

  accountCache = { items, byId, byName, byAcctNum, fetchedAt: Date.now() };
  return accountCache;
}

// Resolve account by name, AcctNum, or ID using cache
export async function resolveAccount(client: QuickBooks, account: string): Promise<CachedAccount> {
  const cache = await getAccountCache(client);

  // Try exact ID match
  const byId = cache.byId.get(account);
  if (byId) return byId;

  // Try exact AcctNum match (case-insensitive)
  const byAcctNum = cache.byAcctNum.get(account.toLowerCase());
  if (byAcctNum) return byAcctNum;

  // Try exact name match (case-insensitive)
  const byName = cache.byName.get(account.toLowerCase());
  if (byName) return byName;

  // Try partial FullyQualifiedName match
  const byPartial = cache.items.find(a =>
    a.FullyQualifiedName?.toLowerCase().includes(account.toLowerCase())
  );
  if (byPartial) return byPartial;

  throw new Error(`Account not found: "${account}". Try using account name, number (AcctNum), or ID.`);
}

export async function getVendorCache(client: QuickBooks): Promise<VendorCache> {
  if (vendorCache && (Date.now() - vendorCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return vendorCache;
  }

  const result = await promisify<unknown>((cb) => client.findVendors({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedVendor>(result, 'Vendor');

  const byId = new Map<string, CachedVendor>();
  const byName = new Map<string, CachedVendor>();
  for (const vendor of items) {
    byId.set(vendor.Id, vendor);
    byName.set(vendor.DisplayName.toLowerCase(), vendor);
  }

  vendorCache = { items, byId, byName, fetchedAt: Date.now() };
  return vendorCache;
}

export async function getEmployeeCache(client: QuickBooks): Promise<EmployeeCache> {
  if (employeeCache && (Date.now() - employeeCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return employeeCache;
  }

  const result = await promisify<unknown>((cb) => client.findEmployees({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedEmployee>(result, 'Employee');

  const byId = new Map<string, CachedEmployee>();
  const byName = new Map<string, CachedEmployee>();
  for (const employee of items) {
    byId.set(employee.Id, employee);
    // QBO synthesises DisplayName from the name parts, but a payroll-only
    // employee record can come back without one — skip rather than key on
    // undefined.
    if (employee.DisplayName) {
      byName.set(employee.DisplayName.toLowerCase(), employee);
    }
  }

  employeeCache = { items, byId, byName, fetchedAt: Date.now() };
  return employeeCache;
}

// Resolve vendor by name or ID using cache
// Returns { value, name } ref object for QuickBooks API
export async function resolveVendor(client: QuickBooks, nameOrId: string): Promise<{ value: string; name: string }> {
  const cache = await getVendorCache(client);

  // Try exact ID match
  const byId = cache.byId.get(nameOrId);
  if (byId) return { value: byId.Id, name: byId.DisplayName };

  // Try exact name match (case-insensitive)
  const byName = cache.byName.get(nameOrId.toLowerCase());
  if (byName) return { value: byName.Id, name: byName.DisplayName };

  // Try partial name match
  const byPartial = cache.items.find(v =>
    v.DisplayName.toLowerCase().includes(nameOrId.toLowerCase())
  );
  if (byPartial) return { value: byPartial.Id, name: byPartial.DisplayName };

  throw new Error(`Vendor not found: "${nameOrId}". Try using vendor display name or ID.`);
}

// Resolve item by name or ID using lazy per-entry cache
// Unlike other caches, items are fetched on demand (companies can have thousands)
export async function resolveItem(client: QuickBooks, nameOrId: string): Promise<{ value: string; name: string }> {
  // Check cache first (with TTL)
  const cached = itemCacheById.get(nameOrId) || itemCacheByName.get(nameOrId.toLowerCase());
  if (cached && (Date.now() - cached.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return { value: cached.Id, name: cached.Name };
  }

  // Query QB for this specific item
  // Try exact name match first, then partial
  const result = await promisify<unknown>((cb) =>
    client.findItems([
      { field: 'Name', value: nameOrId, operator: '=' },
      { field: 'Active', value: true, operator: '=' },
    ], cb)
  );
  let items = extractQueryResults<{ Id: string; Name: string; FullyQualifiedName?: string; Type?: string; UnitPrice?: number; Active?: boolean }>(result, 'Item');

  // If no exact match, try LIKE for partial matching
  if (items.length === 0) {
    const partialResult = await promisify<unknown>((cb) =>
      client.findItems([
        { field: 'Name', value: `%${nameOrId}%`, operator: 'LIKE' },
        { field: 'Active', value: true, operator: '=' },
      ], cb)
    );
    items = extractQueryResults<typeof items[0]>(partialResult, 'Item');
  }

  if (items.length === 0) {
    throw new Error(`Item not found: "${nameOrId}". Try using the exact item name or ID.`);
  }

  // Use first match and cache it
  const item = items[0];
  const entry: CachedItem = {
    Id: item.Id,
    Name: item.Name,
    FullyQualifiedName: item.FullyQualifiedName,
    Type: item.Type,
    UnitPrice: item.UnitPrice,
    Active: item.Active,
    fetchedAt: Date.now(),
  };
  itemCacheById.set(item.Id, entry);
  itemCacheByName.set(item.Name.toLowerCase(), entry);

  return { value: item.Id, name: item.Name };
}

// Helper to resolve department name to ID using cache
// Accepts: internal ID (e.g., "5"), name (e.g., "20400"), or partial match
export async function resolveDepartmentId(client: QuickBooks, department: string): Promise<string> {
  const cache = await getDepartmentCache(client);

  // Try exact ID match first
  const byId = cache.byId.get(department);
  if (byId) return byId.Id;

  // Try exact name match (case-insensitive)
  const byName = cache.byName.get(department.toLowerCase());
  if (byName) return byName.Id;

  // Try partial/fuzzy match on FullyQualifiedName
  const byPartial = cache.items.find(d =>
    d.FullyQualifiedName?.toLowerCase().includes(department.toLowerCase())
  );
  if (byPartial) return byPartial.Id;

  // If nothing found, return as-is (let API handle error)
  return department;
}

// Resolve customer by name or ID using lazy per-entry cache
// Unlike vendor/account caches, customers are fetched on demand (companies can have thousands)
export async function resolveCustomer(client: QuickBooks, nameOrId: string): Promise<{ value: string; name: string }> {
  // Check cache first (with TTL)
  const cached = customerCacheById.get(nameOrId) || customerCacheByName.get(nameOrId.toLowerCase());
  if (cached && (Date.now() - cached.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return { value: cached.Id, name: cached.DisplayName };
  }

  // Query QB for this specific customer — exact DisplayName match first
  const result = await promisify<unknown>((cb) =>
    client.findCustomers([
      { field: 'DisplayName', value: nameOrId, operator: '=' },
      { field: 'Active', value: true, operator: '=' },
    ], cb)
  );
  let customers = extractQueryResults<{ Id: string; DisplayName: string; Active?: boolean }>(result, 'Customer');

  // Then by Id. Every caller advertises "name or ID" and the miss below says so
  // too, but nothing here ever queried Id: a cold lookup by id only worked if
  // that customer happened to have been resolved by name earlier in the session
  // and was still cached. Tried after the exact-name match so a customer
  // literally named "42" still wins its own name.
  if (customers.length === 0 && /^\d+$/.test(nameOrId.trim())) {
    const byId = await promisify<unknown>((cb) =>
      client.findCustomers([{ field: 'Id', value: nameOrId.trim(), operator: '=' }], cb)
    );
    customers = extractQueryResults<typeof customers[0]>(byId, 'Customer');
  }

  // If still nothing, try LIKE for partial matching
  if (customers.length === 0) {
    const partialResult = await promisify<unknown>((cb) =>
      client.findCustomers([
        { field: 'DisplayName', value: `%${nameOrId}%`, operator: 'LIKE' },
        { field: 'Active', value: true, operator: '=' },
      ], cb)
    );
    customers = extractQueryResults<typeof customers[0]>(partialResult, 'Customer');
  }

  if (customers.length === 0) {
    throw new Error(`Customer not found: "${nameOrId}". Try using the exact customer display name or ID.`);
  }

  // Use first match and cache it
  const customer = customers[0];
  const entry: CachedCustomer = {
    Id: customer.Id,
    DisplayName: customer.DisplayName,
    Active: customer.Active,
    fetchedAt: Date.now(),
  };
  customerCacheById.set(customer.Id, entry);
  customerCacheByName.set(customer.DisplayName.toLowerCase(), entry);

  return { value: customer.Id, name: customer.DisplayName };
}

/**
 * An account plus every account nested beneath it, by Id.
 *
 * Report-based tools (the General Ledger behind account_period_summary) roll
 * sub-account activity up into the parent, while entity-based reads match a
 * single AccountRef. Callers that want to agree with the reports need the whole
 * subtree. QBO nests arbitrarily deep, so this walks rather than checking
 * ParentRef one level down.
 */
export function collectAccountTree(cache: AccountCache, rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const account of cache.items) {
    const parentId = account.ParentRef?.value;
    if (!parentId) continue;
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(account.Id);
    else childrenByParent.set(parentId, [account.Id]);
  }

  const ids = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (ids.has(id)) continue; // also guards against a cyclic ParentRef
    ids.add(id);
    for (const childId of childrenByParent.get(id) ?? []) pending.push(childId);
  }
  return ids;
}
