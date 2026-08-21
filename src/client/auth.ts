// QuickBooks client authentication and session management

import QuickBooks from "node-quickbooks";
import { getCredentialProvider, isLocalMode } from "../credentials/index.js";
import type { QBCredentials, CredentialProvider } from "../credentials/index.js";
import { refreshAccessToken } from "../credentials/oauth-client.js";
import { promisify } from "./promisify.js";
import { clearLookupCache } from "./cache.js";

// Sandbox mode for development/testing
const useSandbox = process.env.QBO_SANDBOX === "true";

// QuickBooks client and credentials state
let qbo: QuickBooks | null = null;
let credentials: QBCredentials | null = null;
let companyId: string | null = null;
let provider: CredentialProvider | null = null;

// Export companyId getter for tools that need it
export function getCompanyIdValue(): string | null {
  return companyId;
}

// Clear cached credentials (call on auth errors to force fresh fetch)
export function clearCredentialsCache(): void {
  qbo = null;
  credentials = null;
  clearLookupCache();
}

// Check if error is an authentication failure.
//
// The classification itself lives in utils/errors.ts next to the fault
// extraction it depends on; it is re-exported here because this is where the
// credential cache it drives lives, and because importing this module drags in
// the whole credential provider chain.
export { isAuthFault as isAuthError } from "../utils/errors.js";

// Initialize or refresh the QuickBooks session
export async function getClient(): Promise<QuickBooks> {
  // Get credential provider (singleton)
  if (!provider) {
    provider = getCredentialProvider();
  }

  // Check if credentials are configured
  const isConfigured = await provider.isConfigured();
  if (!isConfigured) {
    if (isLocalMode()) {
      throw new Error(
        "QuickBooks credentials not configured. Run the qbo_authenticate tool to set up OAuth."
      );
    } else {
      throw new Error(
        "QuickBooks credentials not found in AWS. Check your AWS Secrets Manager and SSM Parameter Store configuration."
      );
    }
  }

  // ALWAYS fetch fresh credentials from provider (like Python version)
  credentials = await provider.getCredentials();

  // Load company ID from provider if not cached
  if (!companyId) {
    companyId = await provider.getCompanyId();
  }

  // Create QuickBooks client with current tokens
  qbo = new QuickBooks(
    credentials.client_id,
    credentials.client_secret,
    credentials.access_token,
    false, // No OAuth 1.0 token secret for OAuth 2.0
    companyId,
    useSandbox, // Use sandbox if QBO_SANDBOX=true
    false, // Debug mode off
    null,  // Use latest minor version
    "2.0", // OAuth 2.0
    credentials.refresh_token
  );

  // Refresh the access token
  try {
    const tokenInfo = await promisify<{
      access_token: string;
      refresh_token: string;
    }>((cb) => qbo!.refreshAccessToken(cb));

    // Update credentials and persist to provider immediately
    credentials.access_token = tokenInfo.access_token;
    credentials.refresh_token = tokenInfo.refresh_token;
    await provider.saveCredentials(credentials);
  } catch (refreshError) {
    // For local mode, try using intuit-oauth for refresh as a fallback
    if (isLocalMode()) {
      try {
        credentials = await refreshAccessToken(credentials);
        await provider.saveCredentials(credentials);
      } catch (fallbackError) {
        // If both methods fail, throw the original error
        throw refreshError;
      }
    } else {
      throw refreshError;
    }
  }

  // Recreate client with new tokens
  qbo = new QuickBooks(
    credentials.client_id,
    credentials.client_secret,
    credentials.access_token,
    false,
    companyId,
    useSandbox,
    false, // Debug mode off
    null,
    "2.0",
    credentials.refresh_token
  );

  return qbo;
}
