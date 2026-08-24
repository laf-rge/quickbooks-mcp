import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { crossCheckAgainstGL, renderCrossCheck } from "../../src/query/gl-crosscheck.js";

type Callback<T> = (err: unknown, result: T) => void;

const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;

// A General Ledger section. `Amount` is signed by balance movement: positive
// raises the running balance, in every classification.
function glClient(amounts: number[]): QuickBooks {
  const report = {
    Columns: {
      Column: [
        { ColTitle: "Date" }, { ColTitle: "Transaction Type" }, { ColTitle: "Num" },
        { ColTitle: "Name" }, { ColTitle: "Memo/Description" }, { ColTitle: "Split" },
        { ColTitle: "Amount" }, { ColTitle: "Balance" },
      ],
    },
    Rows: {
      Row: [{
        type: "Section",
        Rows: {
          Row: amounts.map(a => ({
            type: "Data",
            ColData: [
              { value: "2026-07-15" }, { value: "Bill" }, { value: "" }, { value: "" },
              { value: "" }, { value: "" }, { value: a.toFixed(2) }, { value: "0.00" },
            ],
          })),
        },
      }],
    },
  };
  return {
    reportGeneralLedgerDetail: (_o: object, cb: Callback<unknown>) => cb(null, report),
  } as unknown as QuickBooks;
}

const base = { accountId: "1", startDate: "2026-07-01", endDate: "2026-07-31", comparable: true };

describe("crossCheckAgainstGL — when it stays quiet", () => {
  it("says nothing when the figures agree", async () => {
    const check = await crossCheckAgainstGL(glClient([100, -40]), {
      ...base, classification: "Asset",
      drill: { postingCount: 2, totalDebits: 100, totalCredits: 40 },
    });
    assert.equal(check, undefined);
  });

  it("does not fire on a posting count difference alone", async () => {
    // The trap this check nearly shipped with. The ledger reports one row per
    // posting, so a bill with several lines in one account is several rows there
    // and one transaction here. On a live company, multi-line documents produced
    // 562 extra ledger rows in a single month — a count-based check would have
    // reported a shortfall on nearly every account.
    const check = await crossCheckAgainstGL(glClient([60, 40, -40]), {
      ...base, classification: "Asset",
      drill: { postingCount: 1, totalDebits: 100, totalCredits: 40 },
    });
    assert.equal(check, undefined, "a count difference with matching money is not a gap");
  });

  it("tolerates a rounding-sized difference", async () => {
    const check = await crossCheckAgainstGL(glClient([100]), {
      ...base, classification: "Asset",
      drill: { postingCount: 1, totalDebits: 99.5, totalCredits: 0 },
    });
    assert.equal(check, undefined);
  });
});

describe("crossCheckAgainstGL — when it fires", () => {
  it("reports a one-sided shortfall, which is what a coverage gap looks like", async () => {
    // Modelled on A/P: BillPayment carries no APAccountRef, so the credit side
    // matched the ledger exactly while almost every debit was missing.
    const check = await crossCheckAgainstGL(glClient([-1000, 500]), {
      ...base, classification: "Liability",
      drill: { postingCount: 1, totalDebits: 20, totalCredits: 500 },
    });
    assert.ok(check, "expected a divergence");
    assert.equal(check!.shortfall!.debits, 980);
    assert.equal(check!.shortfall!.credits, 0);

    const lines = renderCrossCheck(check, money);
    assert.ok(lines.some(l => l.startsWith("INCOMPLETE")));
    assert.ok(lines.some(l => l.includes("$980.00 of debits")));
    assert.ok(lines.some(l => l.includes("account_period_summary")));
  });

  it("does not list a side that agrees among what is missing", async () => {
    // The headline states both ledger figures; the "missing" clause must name
    // only the side that actually diverged.
    const check = await crossCheckAgainstGL(glClient([-1000, 500]), {
      ...base, classification: "Liability",
      drill: { postingCount: 1, totalDebits: 20, totalCredits: 500 },
    });
    const headline = renderCrossCheck(check, money).find(l => l.includes("is missing"))!;
    const missing = headline.slice(headline.indexOf("is missing"));
    assert.match(missing, /of debits/);
    assert.doesNotMatch(missing, /of credits/);
  });

  it("counts postings in the singular when there is one", async () => {
    const check = await crossCheckAgainstGL(glClient([-1000, 500]), {
      ...base, classification: "Liability",
      drill: { postingCount: 1, totalDebits: 20, totalCredits: 500 },
    });
    assert.match(renderCrossCheck(check, money).join("\n"), /1 posting[^s]/);
  });

  it("reads the ledger's signs against the account's own normal balance", async () => {
    // The same ledger rows mean opposite sides on an asset and a liability, so a
    // check ignoring classification would flag one of them falsely.
    const rows = [100, -40];
    assert.equal(await crossCheckAgainstGL(glClient(rows), {
      ...base, classification: "Asset",
      drill: { postingCount: 2, totalDebits: 100, totalCredits: 40 },
    }), undefined);
    assert.equal(await crossCheckAgainstGL(glClient(rows), {
      ...base, classification: "Liability",
      drill: { postingCount: 2, totalDebits: 40, totalCredits: 100 },
    }), undefined);
  });
});

describe("crossCheckAgainstGL — figures that are not comparable", () => {
  const notComparable = {
    ...base, classification: "Asset", comparable: false,
    drill: { postingCount: 0, totalDebits: 0, totalCredits: 0 },
  };

  it("refuses to call a rollup difference a gap", async () => {
    // The report rolls sub-accounts into the parent; the entity path matches the
    // exact account id. A difference between them says nothing about coverage.
    const check = await crossCheckAgainstGL(glClient([1000]), notComparable);
    assert.ok(check);
    assert.equal(check!.shortfall, undefined);
    const text = renderCrossCheck(check, money).join("\n");
    assert.doesNotMatch(text, /INCOMPLETE/);
    assert.match(text, /include_subaccounts=true/);
  });

  it("still shows the ledger figure, which is the useful number there", async () => {
    const check = await crossCheckAgainstGL(glClient([1000]), notComparable);
    assert.match(renderCrossCheck(check, money).join("\n"), /\$1000\.00/);
  });
});
