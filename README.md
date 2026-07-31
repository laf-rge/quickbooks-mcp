# QuickBooks MCP Server

An MCP server for QuickBooks Online — built for bookkeepers, CFOs, and accountants who use AI assistants in their daily workflow.

Ask your AI assistant to pull a P&L report, create a journal entry, or investigate an account balance — using plain language, not API payloads.

## Why This Server?

Intuit provides an [official MCP server](https://github.com/intuit/quickbooks-online-mcp-server) that's a solid starting point for developers exploring the QuickBooks API. This server takes a different approach: it's designed for **financial professionals working in production books**.

### Use natural language, not internal IDs

Intuit's server requires QuickBooks internal IDs for every reference — you need to look up a vendor's ID before creating a bill. This server resolves names automatically:

```
"Create a bill for PG&E, $450 to Utilities, dated 2025-01-15"
→ Vendor, account, and department names are resolved automatically
```

### Financial reports built in

This is the only QuickBooks MCP server with report tools. Pull a P&L, Balance Sheet, or Trial Balance — broken down by month, department, or class — without leaving your AI conversation.

### Safe by default

Every create and edit operation defaults to **draft/preview mode**. You see exactly what will be written to your books before committing. No accidental journal entries or misclassified expenses.

### One query tool instead of dozens

Instead of separate search tools for each entity type, a single SQL-like `query` tool works across all QuickBooks entities. AI assistants write SQL naturally, and QuickBooks validates it — no field whitelists to maintain.

```
"SELECT * FROM Purchase WHERE TxnDate >= '2025-01-01' AND TxnDate <= '2025-01-31'"
```

### Production-ready credential management

Store credentials locally for personal use, or in AWS Secrets Manager for shared environments. OAuth tokens refresh automatically and persist across sessions.

### At a glance

| | Intuit Official | This Server |
|--|-----------------|-------------|
| **Audience** | Developers exploring the API | Bookkeepers, CFOs, accountants |
| **Name resolution** | Requires internal QB IDs | Resolves names automatically |
| **Financial reports** | None | P&L, Balance Sheet, Trial Balance |
| **Write safety** | Executes immediately | Draft preview by default |
| **Query approach** | Entity-specific search tools | SQL-like queries across all entities |
| **Credentials** | Local `.env` file | Local file or AWS Secrets Manager |
| **Distribution** | Clone from GitHub | `npx quickbooks-mcp` |

## Prerequisites

- **QuickBooks Developer Account**: Register at [developer.intuit.com](https://developer.intuit.com)
- **Node.js 18+**

## Installation Options

Choose the setup that fits your use case:

| Setup | Best For |
|-------|----------|
| [NPM Install](#option-1-npm-install) | Quick setup, using your own QuickBooks app |
| [Local Checkout](#option-2-local-checkout) | Development, customization |
| [AWS Mode](#option-3-aws-mode) | Shared/production environments |

---

## Option 1: NPM Install

The simplest way to get started. Credentials are stored locally on your machine.

### 1. Create a QuickBooks App

1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in
2. Create a new app (or select an existing one)
3. Go to "Keys & credentials"
4. Note your **Client ID** and **Client Secret**
5. Under "Redirect URIs", add: `https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl`

### 2. Add to Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "npx",
      "args": ["-y", "quickbooks-mcp"]
    }
  }
}
```

### 3. Configure Credentials

Create `~/.quickbooks-mcp/credentials.json`:

```json
{
  "client_id": "your_client_id",
  "client_secret": "your_client_secret"
}
```

### 4. Authenticate

Once Claude Code is running, use the `qbo_authenticate` tool:

1. Call `qbo_authenticate` with no arguments to get an authorization URL
2. Open the URL in your browser and authorize the app
3. Copy the `code` and `realmId` from the redirect URL
4. Call `qbo_authenticate` again with the authorization code and realm ID

Your OAuth tokens will be saved and automatically refreshed.

---

## Option 2: Local Checkout

For development or customization.

### 1. Create a QuickBooks App

Follow the same steps as Option 1 above.

### 2. Clone and Build

```bash
git clone https://github.com/laf-rge/quickbooks-mcp.git
cd quickbooks-mcp
npm install
npm run build
```

### 3. Add to Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "node",
      "args": ["/path/to/quickbooks-mcp/dist/index.js"]
    }
  }
}
```

### 4. Configure Credentials

Create `~/.quickbooks-mcp/credentials.json` with your client credentials (same as Option 1), then run `qbo_authenticate` to complete the OAuth flow.

---

## Option 3: AWS Mode

For shared or production environments. Stores credentials in AWS Secrets Manager.

### 1. Create AWS Resources

**Create the secret in Secrets Manager:**

```bash
aws secretsmanager create-secret \
  --name prod/qbo \
  --secret-string '{
    "client_id": "your_client_id",
    "client_secret": "your_client_secret",
    "access_token": "your_access_token",
    "refresh_token": "your_refresh_token",
    "redirect_url": "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl"
  }'
```

**Store Company ID in SSM Parameter Store:**

```bash
aws ssm put-parameter \
  --name /prod/qbo/company_id \
  --value "your_company_id" \
  --type SecureString
```

### 2. Configure the Server

Create a `.env` file in the quickbooks-mcp directory:

```bash
QBO_CREDENTIAL_MODE=aws
AWS_REGION=us-east-2
QBO_SECRET_NAME=prod/qbo
QBO_COMPANY_ID_PARAM=/prod/qbo/company_id
```

> **Note**: Due to a [known Claude Code bug](https://github.com/anthropics/claude-code/issues/1254), environment variables from `.mcp.json` are not reliably passed to MCP servers. The `.env` file workaround is required.

### 3. Add to Claude Code

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "node",
      "args": ["/path/to/quickbooks-mcp/dist/index.js"]
    }
  }
}
```

### 4. IAM Permissions

The server needs these AWS permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:*:*:secret:prod/qbo*"
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": "arn:aws:ssm:*:*:parameter/prod/qbo/*"
    }
  ]
}
```

---

## Inline Output Mode

By default, large responses (reports, query results) are written to `/tmp` files and the server returns a file path. This works well for Claude Code in terminal environments but breaks in **Claude Desktop** and **plugin environments** where the model cannot read from `/tmp`.

Set `QBO_INLINE_OUTPUT=true` to return all responses inline instead.

**Option A — via `.env` file** (recommended for local checkout):

Create a `.env` file in the quickbooks-mcp directory:

```bash
QBO_INLINE_OUTPUT=true
```

**Option B — via `.mcp.json` env block** (recommended for NPM install):

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "npx",
      "args": ["-y", "quickbooks-mcp"],
      "env": {
        "QBO_CREDENTIAL_MODE": "local",
        "QBO_CREDENTIAL_FILE": "~/.quickbooks-mcp/credentials.json",
        "QBO_INLINE_OUTPUT": "true"
      }
    }
  }
}
```

> **Note**: Due to a [known Claude Code bug](https://github.com/anthropics/claude-code/issues/1254), environment variables from `.mcp.json` are not reliably passed to MCP servers in some configurations. If Option B doesn't work, use the `.env` file workaround.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QBO_CREDENTIAL_MODE` | `local` | Credential storage: `local` or `aws` |
| `QBO_CLIENT_ID` | - | QuickBooks app Client ID (local mode) |
| `QBO_CLIENT_SECRET` | - | QuickBooks app Client Secret (local mode) |
| `QBO_CREDENTIAL_FILE` | `~/.quickbooks-mcp/credentials.json` | Custom credential file path |
| `QBO_INLINE_OUTPUT` | `false` | Return responses inline instead of writing to `/tmp` files. Required when using Claude Desktop or plugin environments where file-based output is not accessible to the model. |
| `QBO_SANDBOX` | `false` | Use QuickBooks sandbox environment |
| `AWS_REGION` | `us-east-2` | AWS region (aws mode) |
| `QBO_SECRET_NAME` | `prod/qbo` | Secrets Manager secret name (aws mode) |
| `QBO_COMPANY_ID_PARAM` | `/prod/qbo/company_id` | SSM parameter path (aws mode) |

---

## Available Tools

| Tool | Description |
|------|-------------|
| **Setup** | |
| `qbo_authenticate` | Set up OAuth credentials (local mode only) |
| `get_company_info` | Get connected company information |
| **Query & Reports** | |
| `query` | Run SQL-like queries against any QuickBooks entity |
| `list_accounts` | List chart of accounts with filtering |
| `get_profit_loss` | Profit & Loss report (by month, department, class, etc.) |
| `get_balance_sheet` | Balance Sheet report |
| `get_trial_balance` | Trial Balance report |
| `query_account_transactions` | All transactions affecting a specific account (13 posting entity types, paginated; see `docs/entity-coverage.md` for limits) |
| `account_period_summary` | Period summary for an account (opening/closing balance, debits, credits, count) |
| **Journal Entries** | |
| `create_journal_entry` | Create a journal entry (validates debits = credits) |
| `get_journal_entry` | Fetch a journal entry by ID |
| `edit_journal_entry` | Modify an existing journal entry |
| **Bills** | |
| `create_bill` | Create a vendor bill |
| `get_bill` | Fetch a bill by ID |
| `edit_bill` | Modify an existing bill |
| **Expenses** | |
| `create_expense` | Create an expense (Cash, Check, or Credit Card) |
| `get_expense` | Fetch an expense by ID |
| `edit_expense` | Modify an existing expense |
| **Sales Receipts** | |
| `create_sales_receipt` | Create a sales receipt with item lines |
| `get_sales_receipt` | Fetch a sales receipt by ID |
| `edit_sales_receipt` | Modify an existing sales receipt |
| **Invoices** | |
| `create_invoice` | Create an invoice with item lines (customer required) |
| `get_invoice` | Fetch an invoice by ID |
| `edit_invoice` | Modify an existing invoice |
| **Deposits** | |
| `create_deposit` | Create a bank deposit |
| `get_deposit` | Fetch a deposit by ID |
| `edit_deposit` | Modify an existing deposit |
| **Vendor Credits** | |
| `create_vendor_credit` | Create a vendor credit |
| `get_vendor_credit` | Fetch a vendor credit by ID |
| `edit_vendor_credit` | Modify an existing vendor credit |
| **Bill Payments** | |
| `create_bill_payment` | Pay bills and apply vendor credits (the QBO "check" / pay-bills flow) |
| `get_bill_payment` | Fetch a bill payment by ID; flags unapplied amounts |
| **Delete** | |
| `delete_entity` | Delete any transaction (journal entry, bill, invoice, deposit, sales receipt, expense, vendor credit, bill payment) |

---

## Token Refresh

The server automatically refreshes OAuth tokens on each request and persists them back to your credential store (local file or AWS Secrets Manager).

---

## Development

```bash
npm run dev      # Run in development mode
npm run build    # Build
npm run typecheck # Type check
```

---

## Troubleshooting

### "QuickBooks credentials not configured"

Run the `qbo_authenticate` tool to set up OAuth credentials (local mode only).

### "Authorization code expired"

Authorization codes are only valid for a few minutes. Start the OAuth flow again.

### Token refresh fails

- Check that your refresh token hasn't expired (~100 days)
- Verify your client credentials are correct
- Try re-authenticating with `qbo_authenticate`

### AWS credential errors

- Ensure `.env` file has `QBO_CREDENTIAL_MODE=aws`
- Check your AWS credentials and permissions
- Verify the secret and parameter names match your configuration
