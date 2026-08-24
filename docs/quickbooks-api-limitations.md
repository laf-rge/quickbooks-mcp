# QuickBooks Online API Limitations

## Query Filtering Limitations

Only fields marked as **"filterable"** in the [Intuit API reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account) are queryable in WHERE clauses.

### Accounts That Are Not In The Payload

Some postings carry no account reference at all, so they cannot be found by
matching `*AccountRef` fields in entity JSON:

| Entity | Missing reference |
|--------|-------------------|
| `Invoice` | No `ARAccountRef` — the A/R side is implicit |
| `CreditMemo` | No `ARAccountRef` |
| `Payment` | No `ARAccountRef` (only `DepositToAccountRef`) |
| any sales txn | Sales tax posts via `TxnTaxDetail`, which has `TaxRateRef`, not `AccountRef` |

Use the General Ledger report (via `account_period_summary`) when a complete
account figure is required. See `docs/entity-coverage.md`.

### Entity Names Differ Between URL, Query, and JSON

`CreditCardPayment` uses three spellings: the REST path is `/creditcardpayment`,
the query is `select * from creditcardpayment`, but the JSON wrapper key in both
requests and responses is **`CreditCardPaymentTxn`**. Do not assume the queried
name is the response key — read the key from the response.

### Non-Filterable Reference Fields

The following reference fields are **NOT queryable** on transaction entities:

| Field | Entities Tested | Result |
|-------|-----------------|--------|
| `DepartmentRef` | SalesReceipt, JournalEntry, Purchase, Invoice | `QueryValidationError: property 'DepartmentRef' is not queryable` |
| `AccountRef` | JournalEntry, Invoice, Deposit | `QueryValidationError: Property AccountRef not found for Entity` |

### Commonly Filterable Fields

Based on API documentation, these fields are typically filterable:

- `TxnDate` - Transaction date
- `CreateTime` / `LastUpdatedTime` - Metadata timestamps
- `DocNumber` - Document/reference number
- `CustomerRef` - Customer reference (on some entities)
- `Active` - Active status (on master data entities)

### Workarounds

Since DepartmentRef and AccountRef cannot be filtered server-side:

1. **For Reports**: Use the `department` parameter on P&L and Balance Sheet reports (these use a different API endpoint that supports department filtering)

2. **For Queries**: Fetch all records and filter client-side using tools like `jq`:
   ```bash
   # Filter SalesReceipts by department
   cat results.json | jq '.QueryResponse.SalesReceipt[] | select(.DepartmentRef.value == "5")'

   # Filter JournalEntry lines by account
   cat results.json | jq '.QueryResponse.JournalEntry[].Line[] | select(.JournalEntryLineDetail.AccountRef.value == "123")'
   ```

## Other Query Limitations

From [Intuit's Data Queries documentation](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries):

- **No projections**: Response returns all properties for each object
- **No OR operator**: WHERE clauses don't support OR
- **No GROUP BY**: Aggregation not supported
- **No JOIN**: Cannot join entities
- **Single quotes required**: Comparison values must use single quotes (`'value'`), not double quotes
- **Max 1000 results**: Use `STARTPOSITION` for pagination
- **Wildcard limited to %**: Only `LIKE '%pattern%'` supported, no other wildcards

## Full Update Nulls Omitted Fields — Always Prefer Sparse

This is the single most dangerous QBO update behaviour, and the root cause of a
recurring class of silent data loss in this server. Intuit's own wording, from
the "Full update" section of every transaction entity page:

> The request body must include all writable fields of the existing object as
> returned in a read response. **Writable fields omitted from the request body are
> set to NULL.**

Versus sparse update:

> Sparse updating provides the ability to update a subset of properties for a
> given object; only elements specified in the request are updated. **Missing
> elements are left untouched.**

`node-quickbooks` defaults to `sparse = true` (`index.js`, `module.update`), so a
full update only happens when the caller *explicitly* sets `sparse: false`.

### Sparse update handles line changes — including deletion

Earlier handlers assumed line modifications required a full update. **That is
false.** `Line` is an accepted attribute of the sparse update request body, and
supplying a complete `Line` array replaces the entire array.

Verified against the production company (2026-08-04) with a temporary
SalesReceipt, since deleted:

| Operation | `sparse: true` + full `Line` array | Result |
|-----------|------------------------------------|--------|
| Change line amounts | 2 lines, amounts `1/2` → `5/7` | applied; all header fields intact |
| Delete a line | shortened array, 2 lines → 1 | line deleted; all header fields intact |

So sparse update is strictly better: it does everything a full update does for
lines, and cannot null a field you forgot to copy.

### Which fields actually get nulled

Not every omitted field is lost — QuickBooks re-derives some from company or
vendor defaults. Verified in production by round-tripping temporary records
through a full update built from the old whitelists:

| Field | Full update result |
|-------|--------------------|
| `SalesReceipt.CustomerRef` | **LOST** — silently cleared |
| `Purchase.Credit` | **LOST** — `true` → `false`, so a card refund becomes a charge |
| `Bill.SalesTermRef` | **LOST** |
| `Bill.APAccountRef` | survives (re-defaulted) |
| `CurrencyRef`, `PrintStatus`, `EmailStatus`, `ApplyTaxAfterDiscount`, `CustomField` | survive (re-defaulted) |

`Purchase.Credit` is the one with a dollar impact: dropping it flips the sign of
a credit-card refund. Note `Credit` is only settable when
`PaymentType` is `CreditCard`; QBO silently ignores it for `Cash`/`Check`.

`SalesReceipt.CustomerRef` is nominally **required** per Intuit's docs, yet a
full update omitting it is accepted and clears the field rather than erroring —
which is why this failed silently for so long.

### Real-world damage

This was found in the wild, not in review. Sales receipts created correctly by
an automated importer lost their customer after a single later line edit —
identifiable by `SyncToken 1` on a record whose customer is now empty while its
siblings still have theirs.

Only the customer link was lost; GL lines were untouched, so the P&L and balance
sheet were unaffected. That is what made it survive so long: nothing failed to
balance, and no report errored — the link was simply gone.

### Rule for handlers

Do **not** hand-maintain a list of header fields to copy on update. A whitelist
can never be proven complete, and each omission is silent. Use `sparse: true`
and send only what is changing, plus the entity's required-for-sparse fields
below and a complete `Line` array when lines change.

## Deposited Transactions Cannot Be Edited At All

A sales receipt or payment that has been swept into a Deposit is frozen. Every
update is rejected, sparse or full, even one touching a single header field:

```json
{
  "Fault": {
    "Error": [{
      "Message": "Deposited Transaction cannot be changed",
      "Detail": "This transaction has been deposited. If you want to change or delete it, you must edit the deposit it appears on and remove it first",
      "code": "6540"
    }],
    "type": "ValidationFault"
  }
}
```

The transaction still reads back with `DepositToAccountRef` pointing at
Undeposited Funds; the giveaway is a `LinkedTxn` entry of type `Deposit`:

```json
"LinkedTxn": [{ "TxnId": "123", "TxnType": "Deposit" }]
```

Check for that before attempting an edit, so the failure can be reported as a
business-rule conflict rather than a generic HTTP 400.

### Consequence for repairs

Damage done to a transaction *before* it was deposited cannot be undone through
the API afterwards. Undoing it means removing the transaction from its deposit,
editing it, then putting it back — which changes a deposit that may already be
reconciled against a bank statement. Weigh that against the size of the defect;
a cosmetic field is rarely worth re-opening a completed reconciliation.

## Sparse Update Required Fields

When performing sparse updates (`sparse: true`), certain fields are **required** beyond just `Id` and `SyncToken`, even though you're only updating a subset of the entity.

| Entity | Required Fields | Notes |
|--------|-----------------|-------|
| **JournalEntry** | `Id`, `SyncToken` | Minimal requirements |
| **Bill** | `Id`, `SyncToken`, `VendorRef` | Must include vendor reference |
| **Purchase** (Expense) | `Id`, `SyncToken`, `PaymentType` | PaymentType cannot be changed, but must be included |

### Example Error

If you omit a required field like `PaymentType` on a Purchase update:

```json
{
  "Fault": {
    "Error": [{
      "Message": "Required param missing, need to supply the required value for the API",
      "Detail": "Required parameter PaymentType is missing in the request",
      "code": "2020",
      "element": "PaymentType"
    }],
    "type": "ValidationFault"
  }
}
```

### Implementation Notes

The MCP edit tools (`edit_journal_entry`, `edit_bill`, `edit_expense`) automatically include these required fields by:
1. Fetching the current entity state
2. Copying the required fields to the update payload
3. Applying only the requested changes

## Expense (Purchase) Department Limitations

### Single Department Per Expense

QBO expenses (Purchases) support only **one department at the header level**. While the API schema includes `DepartmentRef` on line-level `AccountBasedExpenseLineDetail`, the API rejects attempts to set line-level departments when lines are added or modified (error: "failed to parse json object; a property specified is unsupported or invalid").

This means an expense transaction **cannot be split across multiple departments**. If a single vendor charge covers multiple locations (e.g., a $59.98 SimpliSafe charge for two stores), it cannot be represented as one expense with two department-tagged lines.

### Workarounds

1. **Split Bills (preferred for recurring)**: Use the bill-splitting workflow in the frontend to create separate bills per department from a single vendor invoice. Each bill gets its own header-level department.

2. **Reclassification Journal Entry (for corrections)**: When expenses are already recorded under the wrong department, create a JE to move the amounts:
   - Debit the expense account in the correct department
   - Credit the expense account in the incorrect department

3. **Separate Expenses**: Manually create individual expense records per department (loses the connection to the single bank/card transaction).

### edit_expense Full Update Bug (Historical)

`edit_expense` used to strip `DepartmentRef` and `EntityRef` on any line edit,
because its full update did not copy them. Those two fields were added to the
copy list in 190ea93, and the handler now uses a sparse update, so line edits no
longer clear them.

Kept here as the first known instance of the whitelist problem described in
[Full Update Nulls Omitted Fields](#full-update-nulls-omitted-fields--always-prefer-sparse).
It was patched by adding the two missing fields rather than by removing the
whitelist, so the same bug resurfaced later on `SalesReceipt.CustomerRef`. Prefer
sparse updates over extending a copy list.

## Delete Takes Id + SyncToken Only — Never Echo A Read

The `?operation=delete` endpoints accept a minimal body:

```json
{ "Id": "123", "SyncToken": "3" }
```

Posting back the entity exactly as it was read is **not** equivalent. A read
returns read-only extension blocks that QBO emits but refuses to accept as
input — `Purchase` carries a `PurchaseEx` whose entries name `javax.xml.bind`
JAXB scopes, and other entities have their own — so the round trip fails
validation with an HTTP 400 that never mentions the block by name.

This matters because of how `node-quickbooks` branches on its argument:

```js
module.delete = function (context, entityName, idOrEntity, callback) {
  if (_.isObject(idOrEntity)) {
    // posted as-is
  } else {
    // re-reads the entity by id and posts the WHOLE entity back
  }
}
```

Passing the bare id string takes the second branch and reproduces the failure.
`delete_entity` therefore reads the entity itself (it needs the `SyncToken`, and
the preview needs the summary) and hands the delete method a fresh
`{ Id, SyncToken }` object, for every entity type — the extension blocks differ
per entity, the hazard does not.

## Entity Attribution Is Four Different Fields

"Which vendor/customer/employee is this for" is one column in the QBO UI and
four unrelated field shapes in the API. There is no uniform `EntityRef`, and a
payload built for one entity type is silently wrong on another — the transaction
saves and the name column comes back blank.

| Where | Field | Shape | Accepts |
|-------|-------|-------|---------|
| Deposit line | `DepositLineDetail.Entity` | `{ value, name, type: "VENDOR" }` | Vendor, Customer, Employee |
| Journal entry line | `JournalEntryLineDetail.Entity` | `{ Type: "Vendor", EntityRef: { value, name } }` | Vendor, Customer, Employee |
| Expense header | `Purchase.EntityRef` | `{ value, name, type: "Vendor" }` | Vendor, Customer, Employee |
| Bill / vendor credit / expense line | `AccountBasedExpenseLineDetail.CustomerRef` | `{ value, name }` | **Customer only** |
| Bill / vendor credit header | `VendorRef` | `{ value, name }` | Vendor only |
| Invoice / sales receipt header | `CustomerRef` | `{ value, name }` | Customer only |

Three things to note:

- **The `type` casing differs by entity.** Deposit lines round-trip an uppercase
  `VENDOR`/`CUSTOMER`/`EMPLOYEE`; `Purchase.EntityRef` uses PascalCase
  `Vendor`. Journal entries do not use a `type` attribute at all — the kind goes
  in a sibling `Type` field beside a nested `EntityRef`.
- **Expense-style lines take a customer and nothing else.** There is no
  vendor-on-a-bill-line. This is why those tools expose `customer_name` while
  deposits and journal entries expose `entity_name` + `entity_type`: the
  parameter names follow what the field can actually hold.
- **A journal entry line posting to A/R or A/P must carry an entity.** QBO
  rejects a receivable line with no customer and a payable line with no vendor.

`src/client/entity-refs.ts` holds the resolution and one shape adapter per
target, so a handler never has to remember which of the four it is writing.

### Setting a CustomerRef can make a line billable

`AccountBasedExpenseLineDetail.CustomerRef` and `BillableStatus` travel
together. A line given a customer with no explicit `BillableStatus` can default
to `Billable`, which queues the cost to be re-invoiced to that customer — a real
accounting change, not a labelling one. These tools write `NotBillable`
alongside any customer they set (and leave an existing `Billable` alone on
edit), because they attribute cost rather than bill it.

## Sales Receipt And Invoice Lines Have No Entity

`SalesItemLineDetail` carries `ItemRef`, `ClassRef`, and tax fields — there is
no per-line customer or entity. The customer is the header `CustomerRef` and
applies to the whole transaction. `create_sales_receipt`, `edit_sales_receipt`,
`create_invoice`, and `edit_invoice` therefore expose `customer_name` at header
level only; the absence of a line-level parameter is the API's shape, not a gap
in the tools.

`create_bill_payment` is the same story: its lines are `LinkedTxn` references to
the bills being paid, and the payee is the header `VendorRef`.

## Report Payloads Do Not Describe Themselves

Everything below was found by running all 29 `report*` methods against a live US
company and comparing the payload to what the report actually means. None of it
is stated in Intuit's docs.

### The General Ledger `Amount` column is signed by balance movement, not by side

A positive `Amount` means the account's running balance went **up**; a negative
one means it went down. This held for every account tested, in every
classification — the sign says nothing about debit or credit on its own.

Which side that is depends on the account's normal balance:

| Classification | Balance up | Balance down |
|---|---|---|
| Asset, Expense | **debit** | credit |
| Liability, Equity, Revenue | **credit** | debit |

So a single fixed mapping from sign to side is right for half the chart of
accounts and backwards for the other half. `parseGLReport` in
`src/tools/handlers/account-period-summary.ts` treated negative as debit
unconditionally, which is correct for liability, equity and revenue accounts and
inverted for asset and expense ones — every bank account included. An expense
account with a month of spending was reported as carrying that spending in
*credits*.

Note that only the **labels** were affected. `netActivity` is the signed sum
either way, and closing balance is opening plus that sum, so both were correct
throughout; it is the split into debits and credits that swapped.

The running `Balance` column is the way to check this without trusting `Amount`:
compare consecutive balances and see which direction a positive amount moves
them. A balance sheet as of each end of the window confirms it independently.

### A report may fill more cells than it declares columns for

`Columns.Column` is not a reliable description of the rows. Sales by item
declares **two** columns and returns **eight** cells per row. Anything that
renders a report by walking the declared column list will silently drop every
value past the last declared column — a wrong answer, not a formatting problem.
Size a table by the widest row as well as by the header list.

### Free-text cells contain the newlines the user typed

Memo and description columns come back with embedded newlines — one cell in a
single month's transaction list spanned 32 lines. Any layout that assumes one
line per row breaks: values land under the wrong heading, and a row-count cap
stops bounding the output. Collapse whitespace before laying a report out.

### A date range on a point-in-time report answers as of *today*

The aging, balance and inventory reports are dated by `report_date`. Given
`start_date`/`end_date` instead, QBO does not error and does not ignore the
request — it returns the report as of today, with `EndPeriod` set to today's
date rather than the range's end. A caller asking for a March aging silently
gets one dated now. Verified for `AgedPayables`, `AgedReceivables`,
`CustomerBalance`, `VendorBalance`, and `InventoryValuationSummary`.
`AccountList` is undated entirely and ignores both.

### Two report methods do not work on a US company

`reportTrialBalanceFR` and `reportTaxSummary` both answer HTTP 400 —
region-specific reports with no US equivalent. The other 27 return data.

### Report criteria are concatenated into the URL unencoded

`module.reportCriteria` in node-quickbooks builds the query string with
`s += p + '=' + criteria[p] + '&'` and no escaping whatsoever. A criterion value
containing `&` or `=` does not arrive as a value — it adds criteria of its own,
and a `#` truncates the query string at the fragment. Resolve names to ids where
possible, and validate any free-text value before passing it. Note that
`resolveDepartmentId` returns an unmatched name *unchanged* for QBO to reject,
so it is not a safe source of ids on its own; `resolveCustomer` and
`resolveVendor` throw instead.

## References

- [Data Queries - Intuit Developer](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries)
- [Deep Dive into QuickBooks Online Data Queries](https://blogs.intuit.com/2017/02/08/deep-dive-sql-queries/)
- [Purchase API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/Purchase)
- [JournalEntry API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/journalentry)
- [Deposit API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/deposit)
- [Reports API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/generalledger)
