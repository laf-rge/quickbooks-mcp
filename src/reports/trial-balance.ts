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
// Deposit - Store Lease"), where the leading account number and the trailing
// leaf both carry meaning and the middle is the expendable part — so drop the
// interior path segments before falling back to a blunt elide.
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

// Which side is "normal" is ordinary double-entry bookkeeping, not something the
// QBO API states: Intuit's Account entity documents Classification, AccountType
// and AccountSubType and says nothing anywhere about normal balance or contra
// accounts. There is no field to read, so the tables below are the mapping.
//
// Classification is the field to lean on — Intuit marks it "read only, system
// defined", so QBO derives it and a user cannot mis-set it. Valid values are
// exactly Asset, Equity, Expense, Liability and Revenue.
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

// Accounts that sit opposite their classification's normal side are handled in
// two tiers of confidence, because AccountSubType cannot carry the weight on its
// own. Intuit documents it as a picker scoped to the AccountType — "Other Asset"
// offers both SecurityDeposits and AccumulatedAmortizationOfOtherAssets, and
// "Fixed Asset" offers both AccumulatedDepreciation and MachineryAndEquipment —
// with no semantic validation. A wrong-but-valid pick is therefore ordinary, and
// real files contain both mistakes: a genuine accumulated-depreciation account
// typed MachineryAndEquipment, and a plain security deposit typed
// AccumulatedAmortizationOfOtherAssets.
//
// Tier 1 — the name says so. Nobody names an account "Accumulated Depreciation"
// by accident, so the expected side is inverted and the account stays checked:
// accumulated depreciation carrying a *debit* is an over-reversed entry or a
// botched disposal, exactly the posting error this pass exists to surface.
const INVERTED_NAME =
  /^(less[\s:-]+)?(accumulated\s+(depreciation|amortization|amortisation|depletion)|allowance\s+for\b)/i;

// Tier 2 — the subtype alone suggests there is no side worth judging. Enough to
// stop us asserting a wrong side, not enough to assert which side is wrong, so
// these are left unchecked rather than judged by a signal that demonstrably
// misfires. The cost is a real error inside one of them going unreported; the
// alternative is flagging every ordinary account carrying a stray subtype.
//
// Values are Intuit's, taken from the AccountSubType list on the Account entity.
const UNJUDGEABLE_SUBTYPES = new Set([
  // Contra assets.
  "AccumulatedDepreciation",
  "AccumulatedAmortization",
  "AccumulatedDepletion",
  "AccumulatedAmortizationOfOtherAssets",
  "CumulativeDepreciationOnIntangibleAssets",
  "AllowanceForBadDebts",
  "ProvisionsCurrentAssets",
  "ProvisionsFixedAssets",
  "ProvisionsNonCurrentAssets",
  // Contra revenue.
  "DiscountsRefundsGiven",
  // Equity accounts that normally carry a debit: draws, distributions and
  // treasury stock. Without these, every owner-managed company gets a permanent
  // false flag.
  "TreasuryStock",
  "DividendDisbursed",
  "PartnerDistributions",
  "PersonalExpense",
  // Equity accounts that legitimately swing either way.
  "RetainedEarnings",
  "AccumulatedAdjustment",
  "AccumulatedOtherComprehensiveIncome",
  // Gain/loss accounts are classified Revenue but carry a debit in a loss year.
  "GainLossOnSaleOfFixedAssets",
  "GainLossOnSaleOfInvestments",
  "LossOnDisposalOfAssets",
  "UnrealisedLossOnSecuritiesNetOfTax",
]);

// Retained earnings by name, for files where the subtype was never set: a debit
// is a cumulative deficit and a credit is retained profit, both facts about the
// business rather than posting errors.
const UNJUDGEABLE_NAME = /^retained\s+earnings\b/i;

// QBO's own suspense buckets, identified by the subtype it assigns them.
// Undeposited Funds is deliberately absent: a balance there is cash in transit,
// which is normal at any close.
const SUSPENSE_SUBTYPES = new Set([
  "OpeningBalanceEquity",
  "UnappliedCashPaymentIncome",
  "UnappliedCashBillPaymentExpense",
]);

// Intuit's subtype list has no "uncategorized" value at all — QBO generates
// those accounts but types them as ordinary ones (Uncategorized Income arrives
// as OtherPrimaryIncome), and bookkeepers retype them freely afterwards. The
// name is the only marker there is. Anchored at the start of the account's own
// name so "Inventory Uncategorized" — a real inventory account — is left alone.
// Clearing accounts are out of scope: nothing in QBO's data says which ones are
// expected to be zero (see issue #49).
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

function opposite(side: Side): Side {
  return side === "debit" ? "credit" : "debit";
}

// Some QBO files keep the account number in AcctNum, others prefix it onto the
// name and leave AcctNum empty. The tests below are anchored at the start of the
// name, so a leading number has to come off first or "1499 Uncategorized Asset"
// silently matches nothing — and a missed suspense account fails toward the
// reassuring answer.
function bareName(account: CachedAccount): string {
  return account.Name.replace(/^\d[\d.-]*\s+/, "").trim();
}

// Tier 1: a contra account the name identifies, checked on its inverted side.
function isInverted(account: CachedAccount): boolean {
  return INVERTED_NAME.test(bareName(account));
}

// Tier 2: an account with no side worth judging, per its subtype alone.
function isUnjudgeable(account: CachedAccount): boolean {
  if (account.AccountSubType && UNJUDGEABLE_SUBTYPES.has(account.AccountSubType)) return true;
  return UNJUDGEABLE_NAME.test(bareName(account));
}

function isSuspense(account: CachedAccount): boolean {
  if (account.AccountSubType && SUSPENSE_SUBTYPES.has(account.AccountSubType)) return true;
  return SUSPENSE_NAME.test(bareName(account));
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
  // Only a numeric-looking leading token is treated as an account number.
  // Accepting any first word would look up "sales" for an unnumbered "Sales Tax
  // Payable" and could collide with a real AcctNum — a wrong join is worse than
  // no join, since it would be silently checked against another account's rules.
  const acctNum = entry.name.match(/^(\d[\d.-]*)\s/)?.[1];
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

    // A name-identified contra outranks the subtype tier: it is the signal we
    // trust, and it is the one that keeps the account checked.
    const inverted = isInverted(account);
    if (!inverted && isUnjudgeable(account)) continue;

    const normal = normalSideOf(account);
    if (!normal) continue;
    const expected = inverted ? opposite(normal) : normal;
    const side: Side = amountCents > 0 ? "debit" : "credit";
    if (side === expected) continue;

    flags.wrongSide.push({
      name: entry.name,
      amountCents,
      reason: `${inverted ? "contra " : ""}${account.Classification || account.AccountType}, normally ${expected}`,
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
