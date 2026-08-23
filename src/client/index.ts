// Barrel export for client module

export { promisify, promisifyWrite } from './promisify.js';
export {
  getClient,
  clearCredentialsCache,
  isAuthError,
  getCompanyIdValue,
} from './auth.js';
export { qboRequest, qboQuery } from './rest.js';
export { newAttemptRecord, withWriteTracking, markWriteIssued } from './write-barrier.js';
export type { AttemptRecord } from './write-barrier.js';
export { withRetry, isRetryableError } from './throttle.js';
export {
  clearLookupCache,
  getDepartmentCache,
  getClassCache,
  getAccountCache,
  getVendorCache,
  getEmployeeCache,
  resolveAccount,
  resolveVendor,
  resolveItem,
  resolveCustomer,
  resolveDepartmentId,
  collectAccountTree,
} from './cache.js';
export {
  resolveAccountRef,
  resolveVendorRef,
  resolveEmployeeRef,
  normalizeEntityKind,
  ENTITY_KINDS,
  toQboRef,
} from './refs.js';
export type {
  AccountRef,
  VendorRef,
  EntityKind,
  ResolvedEntityRef,
  ResolveAccountOptions,
} from './refs.js';
export {
  resolveEntityRef,
  resolveCustomerRef,
  resolveEntityInput,
  resolveCustomerInput,
  toDepositEntity,
  toJournalEntryEntity,
  toPurchaseEntityRef,
} from './entity-refs.js';
export type {
  EntityInputResult,
  EntityLineInput,
  CustomerLineInput,
} from './entity-refs.js';
