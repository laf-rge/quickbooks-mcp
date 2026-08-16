// Handler for qbo_authenticate tool - OAuth flow for local credential mode

import { isLocalMode, getCredentialMode } from "../../credentials/index.js";
import { LocalCredentialProvider } from "../../credentials/local-provider.js";
import {
  generateAuthorizationUrl,
  exchangeCodeForTokens,
  getOAuthInstructions,
} from "../../credentials/oauth-client.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

interface AuthenticateArgs {
  authorization_code?: string;
  realm_id?: string;
}

/**
 * Handle the qbo_authenticate tool
 * This tool does NOT require a QuickBooks client - it's used to set up credentials
 */
export async function handleAuthenticate(args: AuthenticateArgs): Promise<ToolResult> {
  // Check if we're in local mode
  if (!isLocalMode()) {
    return {
      content: [{
        type: "text",
        text: `The qbo_authenticate tool only works in local credential mode.\n\n` +
          `Current mode: ${getCredentialMode()}\n\n` +
          `To use local mode, either:\n` +
          `- Remove QBO_CREDENTIAL_MODE from your environment (local is the default)\n` +
          `- Set QBO_CREDENTIAL_MODE=local\n\n` +
          `AWS mode uses credentials from AWS Secrets Manager and does not require this tool.`,
      }],
      isError: true,
    };
  }

  const localProvider = new LocalCredentialProvider();

  // Check if we have client credentials
  const clientCreds = await localProvider.getClientCredentials();

  if (!clientCreds) {
    return {
      content: [{
        type: "text",
        text: `## Missing Client Credentials\n\n` +
          `To authenticate with QuickBooks, you need to provide your app's client credentials.\n\n` +
          `### Option 1: Environment Variables (Recommended)\n\n` +
          `Set these environment variables:\n` +
          `\`\`\`\n` +
          `QBO_CLIENT_ID=your_client_id\n` +
          `QBO_CLIENT_SECRET=your_client_secret\n` +
          `\`\`\`\n\n` +
          `### Option 2: Create a Credentials File\n\n` +
          `Create \`${localProvider.credentialPath}\` with:\n` +
          `\`\`\`json\n` +
          `{\n` +
          `  "client_id": "your_client_id",\n` +
          `  "client_secret": "your_client_secret"\n` +
          `}\n` +
          `\`\`\`\n\n` +
          `### Getting Client Credentials\n\n` +
          `1. Go to https://developer.intuit.com/\n` +
          `2. Create or select your app\n` +
          `3. Go to "Keys & credentials"\n` +
          `4. Copy the Client ID and Client Secret\n\n` +
          `After setting up credentials, run this tool again.`,
      }],
      isError: true,
    };
  }

  const { clientId, clientSecret } = clientCreds;

  // Step 2: Exchange authorization code for tokens
  if (args.authorization_code) {
    if (!args.realm_id) {
      return {
        content: [{
          type: "text",
          text: `Missing realm_id. When providing authorization_code, you must also provide the realm_id ` +
            `(company ID) from the callback URL.\n\n` +
            `Look for the 'realmId' parameter in the redirect URL.`,
        }],
        isError: true,
      };
    }

    try {
      const result = await exchangeCodeForTokens(
        clientId,
        clientSecret,
        args.authorization_code,
        args.realm_id
      );

      // Save credentials to local file
      await localProvider.saveCredentials(result.credentials);

      return {
        content: [{
          type: "text",
          text: `## Authentication Successful!\n\n` +
            `Connected to QuickBooks company: **${result.companyId}**\n\n` +
            `Credentials have been saved to \`${localProvider.credentialPath}\`.\n\n` +
            `You can now use all other QuickBooks tools to query and manage your data.\n\n` +
            `### Next Steps\n\n` +
            `Try running:\n` +
            `- \`get_company_info\` to verify the connection\n` +
            `- \`list_accounts\` to see your chart of accounts\n` +
            `- \`query\` to run custom queries`,
        }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text",
          text: `## Authentication Failed\n\n` +
            `Error exchanging authorization code for tokens:\n\n` +
            `\`\`\`\n${errorMessage}\n\`\`\`\n\n` +
            `### Common Issues\n\n` +
            `- **Authorization code expired**: Codes are only valid for a few minutes. ` +
            `Try the OAuth flow again.\n` +
            `- **Invalid code**: Make sure you copied the entire code from the URL.\n` +
            `- **Wrong realm_id**: Verify the realmId matches the company you authorized.\n\n` +
            `Run this tool without arguments to get a new authorization URL.`,
        }],
        isError: true,
      };
    }
  }

  // Step 1: Generate authorization URL
  try {
    const authUrl = generateAuthorizationUrl(clientId, clientSecret);
    const instructions = getOAuthInstructions(authUrl);

    return {
      content: [{
        type: "text",
        text: instructions,
      }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: "text",
        text: `Error generating authorization URL: ${errorMessage}`,
      }],
      isError: true,
    };
  }
}
