# QuickBooks MCP Server

## Project Overview

This is a Model Context Protocol (MCP) server that provides Claude with access to QuickBooks Online. It enables Claude to query, create, and edit accounting data including journal entries, bills, expenses, and reports.

## This Repository Is Public

Everything published here is world-readable: commit messages, PR titles, bodies
and comments, issue text, code, comments, tests and fixtures.

This server is developed against a live production QuickBooks company, so real
data is always within reach while debugging. **None of it belongs in anything
published here.** That means no company or trade names, no location or store
identifiers, no chart-of-accounts names or numbers taken from the live books, no
real dollar amounts, and no customer or vendor names.

Use invented fixtures instead — departments like `North`/`South`, accounts like
`4000 Sales`, round amounts like `100.00`.

The rule that matters most in practice: **when a bug is found against live data,
describe the shape of the input, not the input.** "A sub-account name longer than
the column width" and "a value column with no title" are what make a bug
reproducible; pasting the real row adds nothing a reader needs and is how live
figures end up in a public changelog. The same applies to verification evidence —
report what was asserted, not a dump of the books.

Redacting after the fact is awkward: issue and PR bodies can be edited, but
commit messages are permanent without a history rewrite. Get it right on the way
in.

## Git Workflow

This repo uses a branch-and-PR workflow — **never commit directly to `master`**. All changes land via pull request.

- **"commit and push"** means: branch off the latest `master`, commit, push, and open a PR to `master` with `gh pr create`. Then stop — PRs wait for review; do not auto-merge.
- Start from an up-to-date master: `git fetch origin && git switch -c <branch> origin/master`.
- **Branch naming**: `type/short-desc` — `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`. E.g. `fix/scraper-popup`, `chore/bump-deps`.
- Give the PR a descriptive title and a body summarizing what changed and why.

## Architecture

```
src/
├── index.ts           # MCP server entry point (stdio)
├── lambda.ts          # Lambda entry point (HTTP transport)
├── client/            # QuickBooks API client and caching
├── types/             # TypeScript type definitions
├── utils/             # Utility functions (files, URLs, money, output)
├── query/             # Query helpers and pagination
├── reports/           # Report extraction helpers (P&L, Balance Sheet)
└── tools/
    ├── definitions.ts # All tool schema definitions (single file)
    ├── index.ts       # Tool registry, handler map, auth retry dispatcher
    └── handlers/      # One file per tool (or per entity group)
```

## Key Conventions

### Cents-Based Money Handling

All monetary calculations use integer cents to avoid floating-point precision errors:

```typescript
import { validateAmount, toCents, toDollars, sumCents, validateBalance } from "./utils/index.js";

// Validate input (rejects >2 decimal places)
const cents = validateAmount(amount, "Line description");  // throws if 10.001

// Sum safely (integer addition)
const totalCents = sumCents([amountACents, amountBCents]);

// Journal entries must balance exactly
validateBalance(debitsCents, creditsCents);  // throws if not equal
```

### Draft Mode for Writes

All write operations (create/edit) default to `draft: true`:
- Shows a preview of what would be created/modified
- User must explicitly set `draft: false` to commit changes
- Prevents accidental modifications to accounting data

### Account/Department Resolution

Names are auto-resolved to IDs using cached lookups:
- `account_name: "Tips"` → looks up ID from cache
- `department_name: "North"` → looks up ID from cache
- Caches are session-scoped with TTL

## Adding a New Tool

Every new tool requires changes in **4 files** plus README:

1. **`src/tools/handlers/<name>.ts`** — Create handler function
2. **`src/tools/handlers/index.ts`** — Add barrel export
3. **`src/tools/definitions.ts`** — Add tool schema (name, description, inputSchema)
4. **`src/tools/index.ts`** — Import handler + register in `toolHandlers.set()`
5. **`README.md`** — Add row to Available Tools table

Follow the pattern of the nearest existing tool. Use `outputReport()` for any tool that returns data (handles stdio vs HTTP mode automatically).

### HTTP Mode Context Budget

`outputReport()` behaves differently by transport:
- **stdio**: Writes full data to a temp file, returns summary text + filepath. Data never enters LLM context.
- **HTTP**: Returns summary text + **inline JSON**. Everything in the data object goes directly into the LLM's context window.

When building the `reportData` object passed to `outputReport()`, ask: **does the HTTP user need this data inline?**
- **Yes**: Structured summaries, metadata, entity objects needed for follow-up edits (SyncToken, line IDs)
- **No**: Raw API responses, full transaction lists for summary-only tools, redundant data the summary already covers

For tools that return large datasets, cap the detail for HTTP mode using `isHttpMode()` from `src/utils/output.ts`. Compute summaries from the full data, then window the detail. See `account-transactions.ts` (`HTTP_DEFAULT_LIMIT`) for the pattern.

A cap alone is a dead end — the remote caller has no filesystem and cannot reach the rest. Pair it with a way out:

- Window on whole records, not lines, so a page boundary can't split a transaction.
- Default the window by transport: bounded in HTTP, full result set in stdio (the temp file is free).
- Report the position back (`pagination.nextOffset`) **and** say so in the summary text — `query` emits `STARTPOSITION`, `query_account_transactions` emits `offset=`. A truncation notice with no continuation hint is a bug.
- Keep totals computed over the full set so they never change as the caller pages.

## Common Files

| Task | File |
|------|------|
| Change query behavior | `src/query/pagination.ts` |
| Money utilities | `src/utils/money.ts` |
| API client | `src/client/quickbooks.ts` |
| Entities node-quickbooks doesn't wrap | `src/client/rest.ts` |
| Output mode (stdio/http) | `src/utils/output.ts` |

## Critical Limitations

### Expenses Cannot Split Across Departments

QBO expenses (Purchases) only support **one department at the header level**. You cannot create an expense with lines in different departments. If a charge covers multiple locations:
- **Do NOT try to edit expense lines** — `edit_expense` with line changes strips `DepartmentRef` and `EntityRef` (vendor) from the header due to a bug in the full-update code path.
- **Use a reclassification JE** to move amounts between departments after the fact.
- **Use the bill-splitting workflow** (frontend) to create separate per-department bills from a single vendor invoice.

## Building and Testing

```bash
npm run build         # Compile TypeScript (tsc)
npm run build:lambda  # Bundle for Lambda (esbuild → dist-lambda/handler.mjs)
npm run watch         # Watch mode for development
```

Both builds must pass before committing. After changes, restart Claude Code to reload the MCP server.

## Workflow

- Feature backlog is tracked in `wmc-reconcile/docs/quickbooks-mcp-backlog.md` — move items to Completed when done
- Use `closes #N` in commit messages to auto-close GitHub issues
- Commit messages: short imperative subject, body explains the "why"

## QuickBooks API Notes

- All updates require `SyncToken` for optimistic concurrency
- Some entities require additional fields for sparse updates:
  - Bill: `VendorRef`
  - Purchase (Expense): `PaymentType`
- Department/Location filtering must be done client-side (not in QB queries)
- Intuit throttles per realm. Fan out queries with `mapWithConcurrency` (not a
  bare `Promise.all`) and let `withRetry` in `src/client/throttle.ts` handle
  429/5xx — a throttled query returns empty, which silently reads as "no data"
- **Parent vs. sub-account**: report-based tools (`account_period_summary`) roll
  sub-accounts up into the parent; entity-based tools (`query_account_transactions`)
  match the exact account ID only. Pass `include_subaccounts: true` to make them
  agree. Walk the tree with `collectAccountTree` — QBO nests up to 5 deep, so
  checking `ParentRef` one level is not enough
- node-quickbooks only wraps ~35 entities; use `src/client/rest.ts` for the rest
- Some postings have no account reference in the payload (A/R, sales tax) and are
  invisible to entity-based reads — see `docs/entity-coverage.md`
- See `docs/quickbooks-api-limitations.md` for details
