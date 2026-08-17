import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeTrialBalance,
  parseTrialBalance,
  renderTrialBalance,
  renderTrialBalanceFlags,
  TrialBalanceEntry,
} from "../../src/reports/trial-balance.js";
import { CachedAccount } from "../../src/types/index.js";

// --- fixtures ---------------------------------------------------------------

interface Spec {
  id: string;
  name: string;
  acctNum?: string;
  classification?: string;
  type?: string;
  subType?: string;
}

function chart(specs: Spec[]) {
  const byId = new Map<string, CachedAccount>();
  const byAcctNum = new Map<string, CachedAccount>();
  for (const s of specs) {
    const account: CachedAccount = {
      Id: s.id,
      Name: s.name,
      AcctNum: s.acctNum,
      Classification: s.classification,
      AccountType: s.type,
      AccountSubType: s.subType,
    };
    byId.set(s.id, account);
    if (s.acctNum) byAcctNum.set(s.acctNum.toLowerCase(), account);
  }
  return { byId, byAcctNum };
}

function entry(
  accountId: string | undefined,
  name: string,
  debit: string,
  credit = ""
): TrialBalanceEntry {
  return { accountId, name, debit, credit };
}

const ASSET: Spec = { id: "1", name: "Checking", acctNum: "1010", classification: "Asset", type: "Bank" };
const LIABILITY: Spec = { id: "2", name: "Accounts Payable", acctNum: "2000", classification: "Liability", type: "Accounts Payable" };
const INCOME: Spec = { id: "3", name: "Sales", acctNum: "4000", classification: "Revenue", type: "Income" };
const EXPENSE: Spec = { id: "4", name: "Rent", acctNum: "6000", classification: "Expense", type: "Expense" };

// --- parsing ----------------------------------------------------------------

describe("parseTrialBalance", () => {
  it("walks [account, debit, credit] rows and keeps the account id", () => {
    const { entries } = parseTrialBalance([
      { ColData: [{ value: "1010 Checking", id: "1" }, { value: "100.00" }, { value: "" }] },
      { ColData: [{ value: "2000 Accounts Payable", id: "2" }, { value: "" }, { value: "40.00" }] },
    ]);

    assert.deepEqual(entries, [
      { accountId: "1", name: "1010 Checking", debit: "100.00", credit: "" },
      { accountId: "2", name: "2000 Accounts Payable", debit: "", credit: "40.00" },
    ]);
  });

  it("separates the GrandTotal section from the account rows", () => {
    const { entries, total } = parseTrialBalance([
      { ColData: [{ value: "1010 Checking", id: "1" }, { value: "100.00" }, { value: "" }] },
      {
        Summary: { ColData: [{ value: "TOTAL" }, { value: "100.00" }, { value: "100.00" }] },
        type: "Section",
        group: "GrandTotal",
      },
    ]);

    assert.equal(entries.length, 1);
    assert.equal(total?.[1]?.value, "100.00");
  });

  it("ignores rows with no account label", () => {
    const { entries } = parseTrialBalance([{ ColData: [{ value: "" }, { value: "1.00" }, { value: "" }] }]);
    assert.deepEqual(entries, []);
  });
});

describe("renderTrialBalance", () => {
  it("renders an aligned table closed by the total", () => {
    const out: string[] = [];
    renderTrialBalance(
      [
        { ColData: [{ value: "1010 Checking", id: "1" }, { value: "100.00" }, { value: "" }] },
        {
          Summary: { ColData: [{ value: "TOTAL" }, { value: "100.00" }, { value: "100.00" }] },
          type: "Section",
          group: "GrandTotal",
        },
      ],
      out
    );

    assert.match(out.join("\n"), /Account\s+Debit\s+Credit/);
    assert.match(out.join("\n"), /1010 Checking\s+100\.00/);
    assert.match(out.join("\n"), /TOTAL\s+100\.00\s+100\.00/);
  });

  it("emits nothing when the report has no account rows", () => {
    const out: string[] = [];
    renderTrialBalance([], out);
    assert.deepEqual(out, []);
  });
});

// --- wrong-side detection ---------------------------------------------------

describe("analyzeTrialBalance: wrong-side balances", () => {
  const accounts = chart([ASSET, LIABILITY, INCOME, EXPENSE]);
  const analyze = (entries: TrialBalanceEntry[]) =>
    analyzeTrialBalance(entries, accounts.byId, accounts.byAcctNum);

  it("leaves accounts sitting on their normal side alone", () => {
    const flags = analyze([
      entry("1", "1010 Checking", "100.00"),
      entry("2", "2000 Accounts Payable", "", "40.00"),
      entry("3", "4000 Sales", "", "500.00"),
      entry("4", "6000 Rent", "300.00"),
    ]);
    assert.deepEqual(flags.wrongSide, []);
  });

  it("flags an asset with a credit balance", () => {
    const flags = analyze([entry("1", "1010 Checking", "", "250.00")]);
    assert.equal(flags.wrongSide.length, 1);
    assert.equal(flags.wrongSide[0].amountCents, -25000);
    assert.equal(flags.wrongSide[0].reason, "Asset, normally debit");
  });

  it("flags a liability, an income account, and an expense on the wrong side", () => {
    const flags = analyze([
      entry("2", "2000 Accounts Payable", "10.00"),
      entry("3", "4000 Sales", "20.00"),
      entry("4", "6000 Rent", "", "30.00"),
    ]);
    assert.deepEqual(
      flags.wrongSide.map(f => f.reason),
      ["Liability, normally credit", "Revenue, normally credit", "Expense, normally debit"]
    );
  });

  it("never flags a zero balance, however it is expressed", () => {
    const flags = analyze([
      entry("1", "1010 Checking", "0.00"),
      entry("1", "1010 Checking", "", "0.00"),
      entry("1", "1010 Checking", "500.00", "500.00"),
      entry("1", "1010 Checking", "", ""),
    ]);
    assert.deepEqual(flags.wrongSide, []);
  });

  it("reads a negative in the debit column as a credit balance", () => {
    // QBO sometimes negates the debit cell instead of populating the credit one,
    // so the side has to come from the signed net.
    const flags = analyze([entry("1", "1010 Checking", "-250.00")]);
    assert.equal(flags.wrongSide.length, 1);
    assert.equal(flags.wrongSide[0].amountCents, -25000);
  });

  it("parses amounts carrying separators, currency symbols, or parentheses", () => {
    const flags = analyze([
      entry("1", "1010 Checking", "", "$1,234.56"),
      entry("4", "6000 Rent", "(75.00)"),
    ]);
    assert.deepEqual(flags.wrongSide.map(f => f.amountCents), [-123456, -7500]);
  });

  it("falls back to AccountType when Classification is missing", () => {
    const noClass = chart([{ id: "9", name: "Petty Cash", type: "Other Current Asset" }]);
    const flags = analyzeTrialBalance(
      [entry("9", "1050 Petty Cash", "", "10.00")],
      noClass.byId,
      noClass.byAcctNum
    );
    assert.equal(flags.wrongSide.length, 1);
    assert.equal(flags.wrongSide[0].reason, "Other Current Asset, normally debit");
  });

  it("stays silent when neither Classification nor AccountType names a side", () => {
    const unknown = chart([{ id: "9", name: "Mystery", type: "Something New" }]);
    const flags = analyzeTrialBalance(
      [entry("9", "9999 Mystery", "", "10.00")],
      unknown.byId,
      unknown.byAcctNum
    );
    assert.deepEqual(flags.wrongSide, []);
  });
});

// --- contra accounts --------------------------------------------------------

describe("analyzeTrialBalance: contra accounts", () => {
  const accounts = chart([
    { id: "1", name: "Accumulated Depreciation", acctNum: "1599", classification: "Asset", type: "Fixed Asset", subType: "AccumulatedDepreciation" },
    // A contra the subtype misses: both values are valid under Fixed Asset.
    { id: "2", name: "Accumulated Depreciation", acctNum: "1598", classification: "Asset", type: "Fixed Asset", subType: "MachineryAndEquipment" },
    { id: "3", name: "Discounts", acctNum: "4090", classification: "Revenue", type: "Income", subType: "DiscountsRefundsGiven" },
    { id: "4", name: "Allowance for Bad Debts", acctNum: "1205", classification: "Asset", type: "Other Current Asset", subType: "AllowanceForBadDebts" },
    // The mirror image: an ordinary asset carrying a contra subtype. Other Asset
    // offers SecurityDeposits too, but nothing stops the wrong pick.
    { id: "5", name: "Security Deposit", acctNum: "1985", classification: "Asset", type: "Other Asset", subType: "AccumulatedAmortizationOfOtherAssets" },
    { id: "6", name: "Owner Draws", acctNum: "3200", classification: "Equity", type: "Equity", subType: "PartnerDistributions" },
    { id: "7", name: "Loss on Disposal of Assets", acctNum: "4910", classification: "Revenue", type: "Other Income", subType: "LossOnDisposalOfAssets" },
  ]);
  const analyze = (entries: TrialBalanceEntry[]) =>
    analyzeTrialBalance(entries, accounts.byId, accounts.byAcctNum);

  it("accepts a contra account on its own (inverted) side", () => {
    const flags = analyze([
      entry("1", "1599 Accumulated Depreciation", "", "494146.21"),
      entry("2", "1598 Accumulated Depreciation", "", "1000.00"),
      entry("4", "1205 Allowance for Bad Debts", "", "500.00"),
    ]);
    assert.deepEqual(flags.wrongSide, []);
  });

  it("flags a name-identified contra on the wrong side rather than skipping the check", () => {
    // The whole point: accumulated depreciation carrying a debit is an
    // over-reversed entry or a botched disposal, not a benign contra balance.
    const flags = analyze([entry("1", "1599 Accumulated Depreciation", "12000.00")]);
    assert.equal(flags.wrongSide.length, 1);
    assert.equal(flags.wrongSide[0].reason, "contra Asset, normally credit");
  });

  it("recognises a contra account by name when its subtype is misleading", () => {
    const flags = analyze([entry("2", "1598 Accumulated Depreciation", "12000.00")]);
    assert.equal(flags.wrongSide.length, 1);
    assert.equal(flags.wrongSide[0].reason, "contra Asset, normally credit");
  });

  it("leaves a subtype-only contra unchecked rather than inverting on it", () => {
    // "Discounts" is contra by subtype alone. The subtype is not trustworthy
    // enough to assert which side is wrong, so neither side is reported.
    assert.deepEqual(analyze([entry("3", "4090 Discounts", "139083.23")]).wrongSide, []);
    assert.deepEqual(analyze([entry("3", "4090 Discounts", "", "900.00")]).wrongSide, []);
  });

  it("does not flag an ordinary account that carries a stray contra subtype", () => {
    // A security deposit sitting on its normal debit side must stay quiet even
    // though QBO has it typed AccumulatedAmortizationOfOtherAssets.
    const flags = analyze([entry("5", "1985 Security Deposit", "3315.00")]);
    assert.deepEqual(flags.wrongSide, []);
  });

  it("leaves owner draws and gain/loss accounts alone on either side", () => {
    // Equity draws normally carry a debit, and a Revenue-classified gain/loss
    // account carries one in a loss year. Both would otherwise be permanent
    // false flags for owner-managed companies.
    const flags = analyze([
      entry("6", "3200 Owner Draws", "50000.00"),
      entry("7", "4910 Loss on Disposal of Assets", "1200.00"),
    ]);
    assert.deepEqual(flags.wrongSide, []);
  });
});

describe("analyzeTrialBalance: retained earnings", () => {
  const accounts = chart([
    { id: "1", name: "Retained Earnings", acctNum: "3999", classification: "Equity", type: "Equity", subType: "RetainedEarnings" },
    { id: "2", name: "Retained Earnings", acctNum: "3998", classification: "Equity", type: "Equity" },
  ]);

  it("is never flagged on either side", () => {
    // A debit is a cumulative deficit and a credit is retained profit; both are
    // facts about the business, so there is no wrong side to report.
    for (const [debit, credit] of [["433216.33", ""], ["", "433216.33"]]) {
      const flags = analyzeTrialBalance(
        [entry("1", "3999 Retained Earnings", debit, credit), entry("2", "3998 Retained Earnings", debit, credit)],
        accounts.byId,
        accounts.byAcctNum
      );
      assert.deepEqual(flags.wrongSide, []);
    }
  });
});

// --- suspense accounts ------------------------------------------------------

describe("analyzeTrialBalance: uncategorized and suspense accounts", () => {
  const accounts = chart([
    { id: "1", name: "Uncategorized Income", acctNum: "4900", classification: "Revenue", type: "Income", subType: "OtherPrimaryIncome" },
    { id: "2", name: "Uncategorized Asset", acctNum: "1098", classification: "Asset", type: "Other Current Asset", subType: "OtherCurrentAssets" },
    { id: "3", name: "Ask My Accountant", acctNum: "9997", classification: "Expense", type: "Expense" },
    { id: "4", name: "Opening Balance Equity", acctNum: "3000", classification: "Equity", type: "Equity", subType: "OpeningBalanceEquity" },
    { id: "5", name: "Undeposited Funds", acctNum: "1099", classification: "Asset", type: "Other Current Asset", subType: "UndepositedFunds" },
    { id: "6", name: "Inventory Uncategorized", acctNum: "1201", classification: "Asset", type: "Other Current Asset", subType: "Inventory" },
    { id: "7", name: "Payroll Clearing", acctNum: "2206", classification: "Liability", type: "Other Current Liability", subType: "OtherCurrentLiabilities" },
  ]);
  const analyze = (entries: TrialBalanceEntry[]) =>
    analyzeTrialBalance(entries, accounts.byId, accounts.byAcctNum);

  it("flags uncategorized accounts, Ask My Accountant, and opening balance equity", () => {
    const flags = analyze([
      entry("1", "4900 Uncategorized Income", "", "1500.00"),
      entry("3", "9997 Ask My Accountant", "212.50"),
      entry("4", "3000 Opening Balance Equity", "", "9000.00"),
    ]);
    assert.equal(flags.suspense.length, 3);
    assert.deepEqual(flags.suspense.map(f => f.amountCents), [-150000, 21250, -900000]);
  });

  it("leaves a cleared suspense account alone", () => {
    assert.deepEqual(analyze([entry("2", "1098 Uncategorized Asset", "0.00")]).suspense, []);
  });

  it("does not treat undeposited funds as suspense", () => {
    // A balance there is cash in transit, which is normal at any close.
    assert.deepEqual(analyze([entry("5", "1099 Undeposited Funds", "31217.07")]).suspense, []);
  });

  it("only matches 'uncategorized' at the start of the name", () => {
    // "Inventory Uncategorized" is a real inventory account with a standing
    // balance, not a bucket waiting to be cleared.
    const flags = analyze([entry("6", "1201 Inventory Uncategorized", "43717.24")]);
    assert.deepEqual(flags.suspense, []);
    assert.deepEqual(flags.wrongSide, []);
  });

  it("leaves clearing accounts out of scope", () => {
    const flags = analyze([entry("7", "2206 Payroll Clearing", "", "1000.00")]);
    assert.deepEqual(flags.suspense, []);
    assert.deepEqual(flags.wrongSide, []);
  });

  it("reports a suspense account once, not also as wrong-side", () => {
    const flags = analyze([entry("1", "4900 Uncategorized Income", "800.00")]);
    assert.equal(flags.suspense.length, 1);
    assert.deepEqual(flags.wrongSide, []);
  });
});

describe("analyzeTrialBalance: account numbers carried in the name", () => {
  // Plenty of QBO files prefix the number onto Name and leave AcctNum empty.
  const accounts = chart([
    { id: "1", name: "1499 Uncategorized Asset", classification: "Asset", type: "Other Current Asset" },
    { id: "2", name: "1599 Accumulated Depreciation", classification: "Asset", type: "Fixed Asset", subType: "MachineryAndEquipment" },
  ]);

  it("still recognises a suspense account behind a leading number", () => {
    const flags = analyzeTrialBalance(
      [entry("1", "1499 Uncategorized Asset", "600.00")],
      accounts.byId,
      accounts.byAcctNum
    );
    assert.equal(flags.suspense.length, 1);
  });

  it("still recognises a contra account behind a leading number", () => {
    const flags = analyzeTrialBalance(
      [entry("2", "1599 Accumulated Depreciation", "", "9000.00")],
      accounts.byId,
      accounts.byAcctNum
    );
    assert.deepEqual(flags.wrongSide, []);
  });
});

// --- joining back to the chart of accounts ----------------------------------

describe("analyzeTrialBalance: joining rows to accounts", () => {
  const accounts = chart([
    ASSET,
    { id: "5", name: "Sales Tax Payable", acctNum: "SALES", classification: "Liability", type: "Other Current Liability" },
  ]);
  const analyze = (entries: TrialBalanceEntry[]) =>
    analyzeTrialBalance(entries, accounts.byId, accounts.byAcctNum);

  it("falls back to the account number prefix when the row carries no id", () => {
    const flags = analyze([entry(undefined, "1010 Checking", "", "250.00")]);
    assert.equal(flags.wrongSide.length, 1);
    assert.deepEqual(flags.unmatched, []);
  });

  it("refuses to join on a non-numeric leading token", () => {
    // "Sales Tax Payable" must not be looked up as AcctNum "Sales" — a wrong
    // join would silently check the row against another account's rules.
    const flags = analyze([entry(undefined, "Sales Tax Payable", "10.00")]);
    assert.deepEqual(flags.wrongSide, []);
    assert.deepEqual(flags.unmatched, ["Sales Tax Payable"]);
  });

  it("reports rows it could not match instead of dropping them", () => {
    const flags = analyze([entry("999", "8888 Ghost Account", "42.00")]);
    assert.deepEqual(flags.unmatched, ["8888 Ghost Account"]);
  });

  it("does not report an unmatched row that has no balance", () => {
    assert.deepEqual(analyze([entry("999", "8888 Ghost Account", "0.00")]).unmatched, []);
  });
});

// --- rendering --------------------------------------------------------------

describe("renderTrialBalanceFlags", () => {
  const render = (flags: Parameters<typeof renderTrialBalanceFlags>[0]) => {
    const out: string[] = [];
    renderTrialBalanceFlags(flags, out);
    return out.join("\n");
  };

  it("says so plainly when nothing is flagged", () => {
    const text = render({ wrongSide: [], suspense: [], unmatched: [] });
    assert.match(text, /No wrong-side or suspense-account balances\./);
  });

  it("labels each side and counts every section", () => {
    const text = render({
      wrongSide: [{ name: "1010 Checking", amountCents: -25000, reason: "Asset, normally debit" }],
      suspense: [{ name: "4900 Uncategorized Income", amountCents: 80000, reason: "should be cleared at close" }],
      unmatched: [],
    });
    assert.match(text, /Wrong-side balances \(1\):/);
    assert.match(text, /1010 Checking\s+250\.00 CR\s+Asset, normally debit/);
    assert.match(text, /Uncategorized \/ suspense accounts with a balance \(1\):/);
    assert.match(text, /4900 Uncategorized Income\s+800\.00 DR/);
  });

  it("surfaces unmatched rows so 'no flags' cannot mean 'nothing checked'", () => {
    const text = render({ wrongSide: [], suspense: [], unmatched: ["8888 Ghost Account"] });
    assert.match(text, /Not checked — no matching account in the chart of accounts \(1\):/);
    assert.match(text, /8888 Ghost Account/);
  });
});
