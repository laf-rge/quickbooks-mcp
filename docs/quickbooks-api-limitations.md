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

## References

- [Data Queries - Intuit Developer](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries)
- [Deep Dive into QuickBooks Online Data Queries](https://blogs.intuit.com/2017/02/08/deep-dive-sql-queries/)
- [Purchase API Reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/Purchase)
