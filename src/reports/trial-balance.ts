// Trial Balance rendering plus the opt-in close-time flag pass.
//
// Trial Balance has no Section grouping — every account is a bare ColData row of
// [account, debit, credit], closed by a single GrandTotal section. The
// section-based path in summary.ts finds nothing here, which is why this report
// needs a renderer of its own.

import { CachedAccount, QBReportColData, QBReportRow } from "../types/index.js";
import { labelOf } from "./rows.js";

const NAME_WIDTH_CAP = 60;

// Fit an account name to the column without losing what identifies it. QBO
// reports the full path ("1984 Other Assets:Security Deposits Corporate:Security
// Deposits 20400 N. Santa Rosa"), where the leading account number and the
// trailing leaf both carry meaning and the middle is the expendable part — so
// drop the interior path segments before falling back to a blunt elide.
export function elideAccountName(name: string, cap = NAME_WIDTH_CAP): string {
  if (name.length <= cap) return name;

  const parts = name.split(":");
  if (parts.length > 2) {
    const collapsed = `${parts[0]}:…:${parts[parts.length - 1]}`;
    if (collapsed.length <= cap) return collapsed;
  }

  // Still too long (or no path to collapse): keep the head, which carries the
  // account number, and the tail, which distinguishes siblings.
  const tail = Math.floor((cap - 1) / 2);
  const head = cap - 1 - tail;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

export interface TrialBalanceEntry {
  // QBO stamps the Account Id on the label cell, which makes the join back to
  // the account cache exact — no name matching, no sub-account path guessing.
  accountId?: string;
  name: string;
  debit: string;
  credit: string;
}

export interface ParsedTrialBalance {
  entries: TrialBalanceEntry[];
  total?: QBReportColData[];
}

export function parseTrialBalance(rows: QBReportRow[]): ParsedTrialBalance {
  const entries: TrialBalanceEntry[] = [];
  let total: QBReportColData[] | undefined;

  for (const row of rows) {
    if (row.group === "GrandTotal" || row.type === "Section") {
      total = row.Summary?.ColData;
      continue;
    }
    const name = labelOf(row.ColData);
    if (!name) continue;
    entries.push({
      accountId: row.ColData?.[0]?.id,
      name,
      debit: row.ColData?.[1]?.value || "",
      credit: row.ColData?.[2]?.value || "",
    });
  }

  return { entries, total };
}

export function renderTrialBalance(rows: QBReportRow[], out: string[]): void {
  const { entries, total } = parseTrialBalance(rows);
  if (entries.length === 0) return;

  // Debit and credit are told apart by column position alone, so every name must
  // actually fit the column — padEnd only stops padding, it never truncates, and
  // an over-long name would shove its amounts to an offset of their own.
  const names = entries.map(e => elideAccountName(e.name, NAME_WIDTH_CAP));
  const nameWidth = Math.max(...names.map(n => n.length));
  const amountWidth = Math.max(
    ...entries.flatMap(e => [e.debit.length, e.credit.length]),
    6
  );
  // trimEnd: on a report whose whole point is context cost, padding the credit
  // column on every debit-only row is ~10% of the output in trailing spaces.
  const line = (name: string, debit: string, credit: string) =>
    `${name.padEnd(nameWidth)}  ${debit.padStart(amountWidth)}  ${credit.padStart(amountWidth)}`.trimEnd();

  out.push("");
  out.push(line("Account", "Debit", "Credit"));
  entries.forEach((e, i) => out.push(line(names[i], e.debit, e.credit)));

  if (total) {
    out.push(line("TOTAL", total[1]?.value || "", total[2]?.value || ""));
  }
}

// ---------------------------------------------------------------------------
// Flag pass
// ---------------------------------------------------------------------------

type Side = "debit" | "credit";

const NORMAL_SIDE_BY_CLASSIFICATION: Record<string, Side> = {
  Asset: "debit",
  Expense: "debit",
  Liability: "credit",
  Equity: "credit",
  Revenue: "credit",
};

// Fallback for accounts whose Classification did not come back on the entity.
// Covers the full QBO AccountType enum, so a missing Classification degrades to
// the same answer rather than to silence.
const NORMAL_SIDE_BY_ACCOUNT_TYPE: Record<string, Side> = {
  "Bank": "debit",
  "Accounts Receivable": "debit",
  "Other Current Asset": "debit",
  "Fixed Asset": "debit",
  "Other Asset": "debit",
  "Expense": "debit",
  "Other Expense": "debit",
  "Cost of Goods Sold": "debit",
  "Accounts Payable": "credit",
  "Credit Card": "credit",
  "Other Current Liability": "credit",
  "Long Term Liability": "credit",
  "Equity": "credit",
  "Income": "credit",
  "Other Income": "credit",
};

// Accounts whose normal balance is the opposite of their classification's.
// Reporting these would fire on every close, and a flag list that is mostly
// known-benign is a flag list that stops being read.
const CONTRA_SUBTYPES = new Set([
  "AccumulatedDepreciation",
  "AccumulatedAmortization",
  "AccumulatedDepletion",
  "AccumulatedAmortizationOfOtherAssets",
  "AllowanceForBadDebts",
  "DiscountsRefundsGiven",
  // A debit balance in retained earnings is a cumulative deficit — a fact about
  // the business, not a posting error.
  "RetainedEarnings",
]);

// Subtypes under-detect: a hand-built "Accumulated Depreciation" is often typed
// MachineryAndEquipment, and QBO does not correct it. The naming convention is
// the more reliable half of the test.
const CONTRA_NAME =
  /^(less[\s:-]+)?(accumulated\s+(depreciation|amortization|amortisation|depletion)|allowance\s+for\b|retained\s+earnings\b)/i;

// QBO's own suspense buckets, identified by the subtype it assigns them.
// Undeposited Funds is deliberately absent: a balance there is cash in transit,
// which is normal at any close.
const SUSPENSE_SUBTYPES = new Set([
  "OpeningBalanceEquity",
  "UnappliedCashPaymentIncome",
  "UnappliedCashBillPaymentExpense",
]);

// "Uncategorized Income/Expense/Asset" and "Ask My Accountant" are generated by
// QBO but routinely retyped by hand afterwards, so their subtype says nothing
// and the name is the only stable marker. Anchored at the start of the account's
// own name so "Inventory Uncategorized" — a real inventory account — is left
// alone. Clearing accounts are out of scope: nothing in QBO's data says which
// ones are expected to be zero (see issue #49).
const SUSPENSE_NAME = /^(uncategor(ized|ised)\b|ask my accountant\b|opening balance equity\b)/i;

export interface TrialBalanceFlag {
  name: string;
  // Signed net in cents: positive is a debit balance, negative a credit balance.
  amountCents: number;
  reason: string;
}

export interface TrialBalanceFlags {
  wrongSide: TrialBalanceFlag[];
  suspense: TrialBalanceFlag[];
  // Rows that could not be joined to an account. Reported rather than dropped:
  // "no flags" has to mean "nothing flagged", not "nothing checked".
  unmatched: string[];
}

// Report amounts are plain decimal strings, but QBO has been known to emit a
// negative in the debit column instead of a positive credit — so the side comes
// from the signed net, not from which cell is populated.
function parseAmountCents(value: string): number {
  const cleaned = value.trim().replace(/[$,\s]/g, "");
  if (!cleaned) return 0;
  const negated = /^\(.*\)$/.test(cleaned);
  const n = Number(negated ? cleaned.slice(1, -1) : cleaned);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) * (negated ? -1 : 1);
}

function normalSideOf(account: CachedAccount): Side | undefined {
  const byClassification = account.Classification
    ? NORMAL_SIDE_BY_CLASSIFICATION[account.Classification]
    : undefined;
  if (byClassification) return byClassification;
  return account.AccountType ? NORMAL_SIDE_BY_ACCOUNT_TYPE[account.AccountType] : undefined;
}

function isContra(account: CachedAccount): boolean {
  if (account.AccountSubType && CONTRA_SUBTYPES.has(account.AccountSubType)) return true;
  return CONTRA_NAME.test(account.Name);
}

function isSuspense(account: CachedAccount): boolean {
  if (account.AccountSubType && SUSPENSE_SUBTYPES.has(account.AccountSubType)) return true;
  return SUSPENSE_NAME.test(account.Name);
}

// Rows carry the Account Id, so the cache join is normally exact. The account
// number prefix on the report label is the fallback for the rare row QBO stamps
// with no id.
function joinAccount(
  entry: TrialBalanceEntry,
  byId: Map<string, CachedAccount>,
  byAcctNum: Map<string, CachedAccount>
): CachedAccount | undefined {
  if (entry.accountId) {
    const hit = byId.get(entry.accountId);
    if (hit) return hit;
  }
  const acctNum = entry.name.match(/^(\S+)\s/)?.[1];
  return acctNum ? byAcctNum.get(acctNum.toLowerCase()) : undefined;
}

export function analyzeTrialBalance(
  entries: TrialBalanceEntry[],
  byId: Map<string, CachedAccount>,
  byAcctNum: Map<string, CachedAccount>
): TrialBalanceFlags {
  const flags: TrialBalanceFlags = { wrongSide: [], suspense: [], unmatched: [] };

  for (const entry of entries) {
    const amountCents = parseAmountCents(entry.debit) - parseAmountCents(entry.credit);
    // A zero row is the healthy state for exactly the accounts this pass cares
    // about, so it is never a flag on either test.
    if (amountCents === 0) continue;

    const account = joinAccount(entry, byId, byAcctNum);
    if (!account) {
      flags.unmatched.push(entry.name);
      continue;
    }

    if (isSuspense(account)) {
      flags.suspense.push({
        name: entry.name,
        amountCents,
        reason: "should be cleared at close",
      });
      // A suspense account with any balance is already the stronger finding;
      // reporting its side as well would just say the same thing twice.
      continue;
    }

    if (isContra(account)) continue;

    const normal = normalSideOf(account);
    if (!normal) continue;
    const side: Side = amountCents > 0 ? "debit" : "credit";
    if (side === normal) continue;

    flags.wrongSide.push({
      name: entry.name,
      amountCents,
      reason: `${account.Classification || account.AccountType}, normally ${normal}`,
    });
  }

  return flags;
}

function formatAmount(amountCents: number): string {
  return `${(Math.abs(amountCents) / 100).toFixed(2)} ${amountCents > 0 ? "DR" : "CR"}`;
}

export function renderTrialBalanceFlags(flags: TrialBalanceFlags, out: string[]): void {
  const all = [...flags.wrongSide, ...flags.suspense];

  out.push("");
  out.push("FLAGS");

  if (all.length === 0) {
    out.push("No wrong-side or suspense-account balances.");
  } else {
    const names = new Map(all.map(f => [f, elideAccountName(f.name, NAME_WIDTH_CAP)]));
    const nameWidth = Math.max(...[...names.values()].map(n => n.length));
    const amountWidth = Math.max(...all.map(f => formatAmount(f.amountCents).length));
    const line = (flag: TrialBalanceFlag) =>
      `  ${names.get(flag)!.padEnd(nameWidth)}  ${formatAmount(flag.amountCents).padStart(amountWidth)}  ${flag.reason}`;

    if (flags.wrongSide.length > 0) {
      out.push("");
      out.push(`Wrong-side balances (${flags.wrongSide.length}):`);
      flags.wrongSide.forEach(f => out.push(line(f)));
    }
    if (flags.suspense.length > 0) {
      out.push("");
      out.push(`Uncategorized / suspense accounts with a balance (${flags.suspense.length}):`);
      flags.suspense.forEach(f => out.push(line(f)));
    }
  }

  if (flags.unmatched.length > 0) {
    out.push("");
    out.push(
      `Not checked — no matching account in the chart of accounts (${flags.unmatched.length}):`
    );
    flags.unmatched.forEach(name => out.push(`  ${elideAccountName(name, NAME_WIDTH_CAP)}`));
  }
}
