// Local file-based credential provider

import { promises as fs } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import type { CredentialProvider, QBCredentials } from "./types.js";

// Default credential file location
const DEFAULT_CREDENTIAL_PATH = join(homedir(), ".quickbooks-mcp", "credentials.json");

/**
 * Expand a leading ~ to the user's home directory.
 *
 * A shell expands ~ before the value ever reaches process.env, but this server
 * is normally configured through an MCP client's JSON "env" block, where nothing
 * does — so "~/qb/credentials.json" would otherwise be taken literally and
 * create a "./~/qb" directory. Only a leading ~ is expanded; ~user is left alone
 * because resolving another user's home is not something we can do portably.
 */
function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return join(homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Get the credential file path from environment or use default
 */
function getCredentialPath(): string {
  const configured = process.env.QBO_CREDENTIAL_FILE;
  return configured ? expandHome(configured) : DEFAULT_CREDENTIAL_PATH;
}

/**
 * Local file-based credential provider
 * Stores credentials in ~/.quickbooks-mcp/credentials.json by default
 */
export class LocalCredentialProvider implements CredentialProvider {
  private credentialPath: string;

  constructor() {
    this.credentialPath = getCredentialPath();
  }

  async getCredentials(): Promise<QBCredentials> {
    try {
      const content = await fs.readFile(this.credentialPath, "utf-8");
      const stored = JSON.parse(content);

      // Merge with environment variables (env vars take precedence for client credentials)
      const credentials: QBCredentials = {
        client_id: process.env.QBO_CLIENT_ID || stored.client_id,
        client_secret: process.env.QBO_CLIENT_SECRET || stored.client_secret,
        redirect_url: stored.redirect_url || "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl",
        access_token: stored.access_token,
        refresh_token: stored.refresh_token,
        company_id: stored.company_id,
      };

      return credentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Credentials file not found at ${this.credentialPath}. ` +
            "Run qbo_authenticate to set up OAuth credentials."
        );
      }
      throw error;
    }
  }

  async saveCredentials(credentials: QBCredentials): Promise<void> {
    // Ensure directory exists
    const dir = dirname(this.credentialPath);
    await fs.mkdir(dir, { recursive: true });

    // Write credentials file
    await fs.writeFile(
      this.credentialPath,
      JSON.stringify(credentials, null, 2),
      { mode: 0o600 } // Readable only by owner
    );
  }

  async getCompanyId(): Promise<string> {
    const credentials = await this.getCredentials();

    if (!credentials.company_id) {
      throw new Error(
        "Company ID not found in credentials. " +
          "Run qbo_authenticate to complete OAuth setup."
      );
    }

    return credentials.company_id;
  }

  async isConfigured(): Promise<boolean> {
    try {
      const credentials = await this.getCredentials();
      return !!(
        credentials.client_id &&
        credentials.client_secret &&
        credentials.access_token &&
        credentials.refresh_token &&
        credentials.company_id
      );
    } catch {
      return false;
    }
  }

  /**
   * Check if client credentials are available (for OAuth flow)
   * Client ID and secret can come from env vars or stored file
   */
  async hasClientCredentials(): Promise<boolean> {
    // Check environment variables first
    if (process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET) {
      return true;
    }

    // Check stored credentials
    try {
      const content = await fs.readFile(this.credentialPath, "utf-8");
      const stored = JSON.parse(content);
      return !!(stored.client_id && stored.client_secret);
    } catch {
      return false;
    }
  }

  /**
   * Get client credentials for OAuth flow
   * Returns null if not available
   */
  async getClientCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
    const clientId = process.env.QBO_CLIENT_ID;
    const clientSecret = process.env.QBO_CLIENT_SECRET;

    if (clientId && clientSecret) {
      return { clientId, clientSecret };
    }

    // Try to read from file
    try {
      const content = await fs.readFile(this.credentialPath, "utf-8");
      const stored = JSON.parse(content);
      if (stored.client_id && stored.client_secret) {
        return { clientId: stored.client_id, clientSecret: stored.client_secret };
      }
    } catch {
      // File doesn't exist or is invalid
    }

    return null;
  }
}
