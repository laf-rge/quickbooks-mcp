// Cross-check an entity drill-down against the General Ledger.
//
// query_account_transactions reads postings out of entity JSON, which can only
// ever show a posting whose account is named somewhere in the entity. Three
// different things have been missing from it at different times — Transfer,
// CreditCardPayment, and payroll — and each was noticed only because a number
// looked wrong. The first two were closed by adding an entity; payroll cannot
// be, because the v3 Accounting API exposes no queryable entity for it at all
// (Paycheck, PaycheckList and PayrollCheck are not valid query contexts, and
// TaxPayment is unsupported in the US region). Any account that funds payroll is
// therefore permanently short in the drill-down.
//
// The General Ledger report has none of these blind spots: it reports postings,
// not entities. Comparing the two turns a silent shortfall into a stated one,
// and does so without anyone having to enumerate the gaps in advance.

import QuickBooks from "node-quickbooks";
import { promisify, withRetry } from "../client/index.js";
import { parseGLReport } from "../tools/handlers/account-period-summary.js";

export interface DrillDownTotals {
  /**
   * Matching *lines*, not transactions.
   *
   * The General Ledger reports one row per posting, so a journal entry with two
   * lines in this account is two rows there and one transaction here. Comparing
   * the report's row count against a transaction count reports a shortfall on
   * any account that carries a multi-line entry — which on a bank account funded
   * by payroll is every period.
   */
  postingCount: number;
  totalDebits: number;
  totalCredits: number;
}

export interface CrossCheck {
  gl: { postingCount: number; totalDebits: number; totalCredits: number };
  /** Absent when the two figures are not comparable; see `note`. */
  shortfall?: { postings: number; debits: number; credits: number };
  note?: string;
}

// A drill-down and a report will not agree to the cent — a rounding difference
// or a single straddling transaction is noise, not a coverage gap. Warn on a
// difference that is both more than a dollar and more than this share of the
// General Ledger figure.
const MATERIAL_FRACTION = 0.005;
const MATERIAL_DOLLARS = 1;

function material(drill: number, gl: number): boolean {
  const diff = Math.abs(gl - drill);
  if (diff <= MATERIAL_DOLLARS) return false;
  return gl === 0 ? true : diff / Math.abs(gl) > MATERIAL_FRACTION;
}

/**
 * Read the General Ledger for the same account and period and compare.
 *
 * `comparable` is false when the drill-down was scoped to one account but the
 * account has children: the report rolls sub-accounts into the parent and the
 * entity path matches the exact account id, so the two are measuring different
 * things and any difference between them says nothing about coverage.
 */
export async function crossCheckAgainstGL(
  client: QuickBooks,
  args: {
    accountId: string;
    classification?: string;
    startDate: string;
    endDate: string;
    departmentId?: string;
    comparable: boolean;
    drill: DrillDownTotals;
  }
): Promise<CrossCheck | undefined> {
  const options: Record<string, string> = {
    account: args.accountId,
    start_date: args.startDate,
    end_date: args.endDate,
  };
  if (args.departmentId) options.department = args.departmentId;

  const report = await withRetry(() =>
    promisify<unknown>((cb) => client.reportGeneralLedgerDetail(options, cb))
  );

  const gl = parseGLReport(report as Parameters<typeof parseGLReport>[0], args.classification);
  const totals = {
    postingCount: gl.transactionCount,
    totalDebits: gl.totalDebits,
    totalCredits: gl.totalCredits,
  };

  if (!args.comparable) {
    return {
      gl: totals,
      note:
        "The general ledger figure below rolls sub-accounts into the parent, so it " +
        "is not comparable with this result. Pass include_subaccounts=true to compare like with like.",
    };
  }

  const shortfall = {
    postings: totals.postingCount - args.drill.postingCount,
    debits: totals.totalDebits - args.drill.totalDebits,
    credits: totals.totalCredits - args.drill.totalCredits,
  };

  // Money is the test that matters, and a posting count on its own is a weak
  // signal: the ledger splits a transaction QBO reports as one row into several
  // when it posts to the account more than once, and the drill-down can legally
  // group them differently. Only report a count difference alongside a real
  // difference in the figures.
  const diverges =
    material(args.drill.totalDebits, totals.totalDebits) ||
    material(args.drill.totalCredits, totals.totalCredits);

  return diverges ? { gl: totals, shortfall } : undefined;
}

/** The lines to append to the drill-down summary, if any. */
export function renderCrossCheck(check: CrossCheck | undefined, money: (n: number) => string): string[] {
  if (!check) return [];

  if (check.note) {
    return [
      "",
      `General ledger for this period: ${check.gl.postingCount} postings | ` +
        `Debits: ${money(check.gl.totalDebits)} | Credits: ${money(check.gl.totalCredits)}`,
      check.note,
    ];
  }

  const s = check.shortfall!;
  const parts: string[] = [];
  if (s.postings !== 0) {
    const n = Math.abs(s.postings);
    parts.push(`${n} posting${n === 1 ? "" : "s"}`);
  }
  if (Math.abs(s.debits) > MATERIAL_DOLLARS) parts.push(`${money(s.debits)} of debits`);
  if (Math.abs(s.credits) > MATERIAL_DOLLARS) parts.push(`${money(s.credits)} of credits`);

  return [
    "",
    `INCOMPLETE: the general ledger reports ${check.gl.postingCount} postings, ` +
      `${money(check.gl.totalDebits)} of debits and ${money(check.gl.totalCredits)} of credits ` +
      `for this account and period. This drill-down is missing ${parts.join(", ")}.`,
    "Some postings cannot be expressed in entity JSON — payroll has no queryable entity at all, " +
      "and any posting whose account is not explicit on the entity is invisible here. " +
      "Use account_period_summary for totals; use this tool to identify individual transactions.",
  ];
}
