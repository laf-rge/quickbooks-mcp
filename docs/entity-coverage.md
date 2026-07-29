# Entity Coverage

What the read tools can and cannot see, and why. Derived from the [Intuit
all-entities reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account)
and from `node_modules/node-quickbooks/index.js` as of v2.0.46.

## Three layers of coverage

A read tool can only surface a posting if **all three** hold:

1. **The entity is queryable** — QBO exposes it at `/query`.
2. **We can reach it** — either node-quickbooks wraps it, or we go through
   `src/client/rest.ts`.
3. **The account is explicit in the entity JSON** — there is an `*AccountRef`
   to match against. This is the layer that cannot be fixed in our code.

## Layer 2: entities node-quickbooks does not wrap

node-quickbooks declares one prototype method per entity and keeps its generic
CRUD helpers on the CommonJS `module` object rather than `module.exports`, so
omitted entities are unreachable through the client object. Six queryable
entities fall in that gap:

| Entity | Notes |
|---|---|
| CreditCardPayment | Posting. Reached via raw REST; covered by `query` and `query_account_transactions`. |
| TaxPayment | Posting. Reachable via `query`; not in the account drill-down (line shape unverified). |
| InventoryAdjustment | Posting. Same as above. |
| ReimburseCharge | Billable-expense link. Reachable via `query`. |
| RecurringTransaction | A template, not a posting transaction. |
| TaxClassification | Reference data. |

`src/query/pagination.ts` resolves this automatically: `fetcherForEntity()` uses
the wrapper method when one exists and raw REST otherwise, so `query` reaches
every queryable entity without an allow-list to maintain.

### The CreditCardPayment naming trap

Three different spellings for one entity — worth knowing before adding write
support:

| Context | Spelling |
|---|---|
| REST path | `/v3/company/<realmID>/creditcardpayment` |
| Query statement | `select * from creditcardpayment` |
| **JSON wrapper key (request and response)** | **`CreditCardPaymentTxn`** |

Pagination discovers the response key dynamically (first array-valued key in
`QueryResponse`), so this costs nothing on the read path. Any future
create/update handler must send and unwrap `CreditCardPaymentTxn`.

## Layer 3: postings with no account reference — structurally invisible

These cannot be recovered from entity JSON at any amount of effort, because QBO
never puts the account in the payload:

| Posting | Why it is invisible |
|---|---|
| A/R side of Invoice | **Invoice has no `ARAccountRef`.** Confirmed against the entity reference. |
| A/R side of CreditMemo | Same — no `ARAccountRef`. |
| A/R side of Payment | Same. Only `DepositToAccountRef` is exposed. |
| Sales tax liability | Posts through `TxnTaxDetail`, which carries `TaxRateRef`, not an `AccountRef`. |
| Item-driven COGS / inventory | Derived from the Item's configured accounts, not stated on the line. |

Consequence: **`query_account_transactions` can never be complete on an A/R or
sales-tax-liability account.** A/P is fine — `APAccountRef` is explicit on Bill,
BillPayment, and VendorCredit.

The tool now says so in its output when the resolved account is Accounts
Receivable or Other Current Liability, so a short result is not mistaken for no
activity. For a complete figure on those accounts, use `account_period_summary`,
which reads the General Ledger report. Reports show every posting regardless of
whether the account appears in the entity JSON — a GL-report-backed drill-down
is the correct long-term fix for this whole class of gap.

## Posting entities in `query_account_transactions`

| Entity | Scanned | Sides extracted |
|---|:--:|---|
| JournalEntry | ✅ | every line, signed by `PostingType` |
| Purchase | ✅ | header `AccountRef` (credit) + `AccountBasedExpenseLineDetail` (debit) |
| Deposit | ✅ | header `DepositToAccountRef` (debit) + `DepositLineDetail` (credit) |
| SalesReceipt | ✅ | header `DepositToAccountRef` (debit) + `ItemAccountRef` (credit) |
| Bill | ✅ | header `APAccountRef` (credit) + expense lines (debit) |
| Invoice | ✅ | `DepositToAccountRef`/`Deposit` (debit) + income lines (credit). A/R invisible. |
| Payment | ✅ | header `DepositToAccountRef` (debit). A/R invisible. |
| BillPayment | ✅ | `APAccountRef` (debit) + `CheckPayment.BankAccountRef` or `CreditCardPayment.CCAccountRef` (credit) |
| VendorCredit | ✅ | `APAccountRef` (debit) + expense lines (credit) |
| Transfer | ✅ | `ToAccountRef` (debit) + `FromAccountRef` (credit) |
| CreditMemo | ✅ | income lines (debit). A/R invisible. |
| RefundReceipt | ✅ | `DepositToAccountRef` (credit) + income lines (debit) |
| CreditCardPayment | ✅ | `CreditCardAccountRef` (debit) + `BankAccountRef` (credit) |
| TaxPayment | ❌ | posting, line shape unverified |
| InventoryAdjustment | ❌ | posting, line shape unverified |
| Estimate, PurchaseOrder, TimeActivity | ❌ | non-posting by design |
| RecurringTransaction | ❌ | template, not a transaction |

Every call reports `coverage.scannedEntityTypes` in its report data, and warns
in the summary when an individual entity query failed, so an incomplete
drill-down is never presented as a complete one.

### Known partial extractions

Real gaps within entities that *are* scanned:

- **`ItemBasedExpenseLineDetail` is ignored** on Purchase and Bill — only
  `AccountBasedExpenseLineDetail` lines are read. Item-based expense lines are
  invisible.
- **SalesReceipt / Invoice / CreditMemo / RefundReceipt lines without an explicit
  `ItemAccountRef` are skipped**, since the income account is then implied by the
  Item.

## QBO app links

`src/utils/urls.ts` maps entity → QBO app route. The routes are not derivable
from entity names (`journalentry` → `journal`, `purchase` → `expense`), so a
mapping is only added once confirmed against a real transaction. Unmapped
entities return `null` and callers omit the link rather than emit a guessed 404.

Confirmed: journalentry, purchase, deposit, salesreceipt, bill, billpayment,
invoice, payment, customer.

Not yet confirmed (no link emitted): vendorcredit, transfer, creditmemo,
refundreceipt, creditcardpayment.
