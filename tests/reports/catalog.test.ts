import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { REPORT_CATALOG, REPORT_NAMES, dedicatedToolFor, resolveReportName } from "../../src/reports/catalog.js";

describe("report catalog", () => {
  it("resolves its own key", () => {
    assert.equal(resolveReportName("aged_payables"), "aged_payables");
  });

  it("resolves QuickBooks' spelling, which is what the docs show", () => {
    assert.equal(resolveReportName("AgedPayables"), "aged_payables");
    assert.equal(resolveReportName("aged payables"), "aged_payables");
    assert.equal(resolveReportName("  AGED-PAYABLES "), "aged_payables");
  });

  it("resolves the reports whose method name and report name differ", () => {
    // reportGeneralLedgerDetail returns a report QBO calls GeneralLedger;
    // reportAccountListDetail returns AccountList. Both spellings must land.
    assert.equal(resolveReportName("general_ledger"), "general_ledger");
    assert.equal(resolveReportName("GeneralLedgerDetail"), "general_ledger");
    assert.equal(resolveReportName("account_list"), "account_list");
    assert.equal(resolveReportName("AccountListDetail"), "account_list");
  });

  it("does not resolve an unknown name", () => {
    assert.equal(resolveReportName("balance_sheet_v2"), undefined);
  });

  it("names the tool to use for a report it deliberately omits", () => {
    // A nearest-name search answers "vendor_balance" for "trial_balance" — a
    // real report, wrong answer, and one the caller may go on to run.
    assert.equal(dedicatedToolFor("trial_balance"), "get_trial_balance");
    assert.equal(dedicatedToolFor("TrialBalance"), "get_trial_balance");
    assert.equal(dedicatedToolFor("profit_and_loss"), "get_profit_loss");
    assert.equal(dedicatedToolFor("balance_sheet"), "get_balance_sheet");
    assert.equal(dedicatedToolFor("aged_payables"), undefined);
    // The detail variant has no tool of its own and must not be diverted.
    assert.equal(dedicatedToolFor("profit_and_loss_detail"), undefined);
  });

  it("omits the reports that have a dedicated tool", () => {
    // Two ways to ask for a P&L, one of them worse, is a trap for the model.
    for (const name of ["profit_and_loss", "balance_sheet", "trial_balance"]) {
      assert.equal(resolveReportName(name), undefined, `${name} should not be in the catalog`);
    }
    // The detail variant has no tool of its own, so it stays.
    assert.equal(resolveReportName("profit_and_loss_detail"), "profit_and_loss_detail");
  });

  it("omits the reports that answer HTTP 400 on a US company", () => {
    assert.equal(resolveReportName("TrialBalanceFR"), undefined);
    assert.equal(resolveReportName("TaxSummary"), undefined);
  });

  it("advertises exactly what it can dispatch", () => {
    assert.deepEqual(REPORT_NAMES, Object.keys(REPORT_CATALOG).sort());
    for (const name of REPORT_NAMES) {
      assert.match(REPORT_CATALOG[name].method, /^report[A-Z]/);
      assert.ok(REPORT_CATALOG[name].label.length > 0);
    }
  });

  it("gives every report a distinct method", () => {
    const methods = REPORT_NAMES.map(n => REPORT_CATALOG[n].method);
    assert.equal(new Set(methods).size, methods.length);
  });
});
