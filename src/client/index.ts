// Barrel export for client module

export { promisify } from './promisify.js';
export {
  getClient,
  clearCredentialsCache,
  isAuthError,
  getCompanyIdValue,
} from './auth.js';
export { qboRequest, qboQuery } from './rest.js';
export { withRetry, isRetryableError } from './throttle.js';
export {
  clearLookupCache,
  getDepartmentCache,
  getClassCache,
  getAccountCache,
  getVendorCache,
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
  toQboRef,
} from './refs.js';
export type {
  AccountRef,
  VendorRef,
  ResolveAccountOptions,
} from './refs.js';
