// Cache types for account and department lookups

export interface CachedDepartment {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
}

export interface CachedAccount {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  AcctNum?: string;
  AccountType?: string;
  CurrentBalance?: number;
  Active?: boolean;
}

export interface DepartmentCache {
  items: CachedDepartment[];
  byId: Map<string, CachedDepartment>;
  byName: Map<string, CachedDepartment>;  // lowercase key
  fetchedAt: number;
}

export interface CachedClass {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
}

export interface ClassCache {
  items: CachedClass[];
  byId: Map<string, CachedClass>;
  byName: Map<string, CachedClass>;       // lowercase key (Name and FullyQualifiedName)
  fetchedAt: number;
}

export interface AccountCache {
  items: CachedAccount[];
  byId: Map<string, CachedAccount>;
  byName: Map<string, CachedAccount>;      // lowercase key
  byAcctNum: Map<string, CachedAccount>;   // lowercase key
  fetchedAt: number;
}

export interface CachedVendor {
  Id: string;
  DisplayName: string;
  Active?: boolean;
}

export interface VendorCache {
  items: CachedVendor[];
  byId: Map<string, CachedVendor>;
  byName: Map<string, CachedVendor>;       // lowercase key
  fetchedAt: number;
}

export interface CachedCustomer {
  Id: string;
  DisplayName: string;
  Active?: boolean;
  fetchedAt: number;   // per-entry TTL for lazy cache
}

export interface CachedItem {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  Type?: string;       // "Service", "Inventory", "NonInventory", "Group", etc.
  UnitPrice?: number;
  Active?: boolean;
  fetchedAt: number;   // per-entry TTL for lazy cache
}
