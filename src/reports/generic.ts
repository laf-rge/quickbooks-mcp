// A renderer for any QuickBooks report, driven by the report's own columns.
//
// extractReportSummary cannot do this job. It reads a report through a fixed
// list of section groups (Income, COGS, … / TotalAssets, …) and prints the ones
// it recognizes, which is exactly right for a P&L or balance sheet and renders
// nothing at all for anything else: of the reports QBO offers, most carry no
// `group` on their rows whatsoever, so every row is skipped and the output stops
// after the title. Worse are the flat ones — aging, vendor balance, sales by
// department — which have no sections either, so they fall through to the trial
// balance renderer and come back with their columns relabelled `Debit`/`Credit`.
// An aging report has five bucket columns and a total; presenting the first of
// them as a debit is not a formatting quirk, it is a wrong answer.
//
// So this renderer assumes nothing about what the report means. It takes the
// column titles from the payload, walks the row tree, and lays the result out as
// an indented table. A P&L rendered this way loses the curated section ordering
// the dedicated tool gives it, which is why the dedicated tools stay.

import { QBReport, QBReportRow, QBReportColData } from "../types/index.js";
import { elideAccountName } from "./trial-balance.js";

// The label column is the one a reader scans, and on a general ledger it holds
// account paths that a blunt truncation would render indistinguishable, so it
// gets both a wider budget than a value cell and elideAccountName's
// path-collapsing. It is applied after indentation, to the string that actually
// occupies the column.
const LABEL_CAP = 45;

// Ceiling on a single value cell. Memo and description columns carry free text
// a user typed, which on a transaction list runs to hundreds of characters; the
// column is sized to its widest cell, so one long memo pads every other row out
// to match and costs more than the rest of the table put together.
const VALUE_CAP = 40;

// Rendered rows kept before the table is cut off. A journal or general ledger
// over any useful period runs to thousands of rows; rendering them all would
// spend the context window on a report the caller can read in full from the
// payload. See the truncation notice for how to get past it.
export const DEFAULT_MAX_ROWS = 200;

// Ceiling on the rendered table in characters.
//
// A row count alone does not bound a response, because nothing bounds the width
// of a row: summarize_by month over a few years gives a column per month, and at
// forty-odd columns a couple of thousand rows is larger than the context window
// it was meant to protect. The budget is what actually holds, and it leaves the
// narrow reports — where a row costs ~40 characters — free to render most of a
// thousand rows before it binds at all.
export const MAX_RENDER_CHARS = 40_000;

export interface GenericReportOptions {
  /** Fallback title when the payload carries no ReportName. */
  label?: string;
  /**
   * Rows nested inside a section. 'summary' keeps section headers and their
   * subtotals; 'full' also prints the leaf rows underneath. Rows at the top
   * level are always printed — on a flat report they are the entire report.
   */
  detail?: "summary" | "full";
  maxRows?: number;
  /**
   * How the caller reaches the rows the table left out. Transport-dependent:
   * in stdio the whole payload is on disk beside the summary, over HTTP it is
   * only there if it was asked for. Naming a route that does not exist in the
   * current mode is the dead end a cap is supposed to avoid.
   */
  overflowHint?: string;
}

interface TableRow {
  indent: number;
  label: string;
  values: string[];
}

// Cells are laid out by padding to a column width, which silently assumes each
// one occupies a single line. Free-text fields break that assumption: memos and
// descriptions come back from QBO with the newlines the user typed still in
// them, and a cell containing one splits its row in half — every column after it
// lands under the wrong heading, and the row count that bounds this report's
// size stops matching the lines actually emitted.
function flatten(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function clean(value: string | undefined): string {
  const flat = flatten(value);
  return flat.length > VALUE_CAP ? `${flat.slice(0, VALUE_CAP - 1)}…` : flat;
}

function cellsOf(cols: QBReportColData[] | undefined): { label: string; values: string[] } {
  const cells = cols ?? [];
  return {
    // Flattened but not truncated here: the label is cut to LABEL_CAP later,
    // once the indent it shares the column with is known.
    label: flatten(cells[0]?.value),
    // An empty cell stays an empty string: dropping it would shift every later
    // value one column left and file it under the wrong heading.
    values: cells.slice(1).map(c => clean(c.value)),
  };
}

// A row is a section when it has children. QBO also marks sections with
// type: "Section", but not on every report, so the shape is the safer test.
function collect(
  rows: QBReportRow[],
  depth: number,
  full: boolean,
  out: TableRow[],
  // Counts what 'summary' left out, so the response can say so instead of
  // looking complete.
  hidden: { count: number }
): void {
  for (const row of rows) {
    const nested = row.Rows?.Row;

    if (nested && nested.length > 0) {
      const header = cellsOf(row.Header?.ColData);
      // Guard on the values too, not just the label. A header cell can be blank
      // while the columns beside it are populated, and gating on the label alone
      // would drop those figures without a word — the same test Summary below
      // already makes.
      if (header.label || header.values.some(Boolean)) {
        out.push({ indent: depth, label: header.label, values: header.values });
      }

      // A row may carry its own cells *and* children. account-period-summary
      // parses the same General Ledger payload and handles that shape, so it is
      // reachable; skipping straight to the children would lose this row's
      // figures silently.
      const own = cellsOf(row.ColData);
      if (own.label || own.values.some(Boolean)) {
        out.push({ indent: depth, label: own.label, values: own.values });
      }

      collect(nested, depth + 1, full, out, hidden);
      const summary = cellsOf(row.Summary?.ColData);
      if (summary.label || summary.values.some(Boolean)) {
        out.push({
          indent: depth + 1,
          label: summary.label || "Total",
          values: summary.values,
        });
      }
      continue;
    }

    // A childless section still carries its figures in Summary — this is how a
    // GrandTotal row arrives, and on a report with no matching transactions it
    // is the only row there is.
    if (!row.ColData && row.Summary?.ColData) {
      const summary = cellsOf(row.Summary.ColData);
      out.push({ indent: depth, label: summary.label || "Total", values: summary.values });
      continue;
    }

    // Leaf. Nested leaves are the bulk of a detail report, so they are what
    // 'summary' drops; a top-level leaf is kept either way.
    if (depth > 0 && !full) {
      hidden.count++;
      continue;
    }
    const leaf = cellsOf(row.ColData);
    if (leaf.label || leaf.values.some(Boolean)) {
      out.push({ indent: depth, label: leaf.label, values: leaf.values });
    }
  }
}

// Returns the number of rows actually rendered, which the caller needs to
// report the shortfall honestly.
function renderTable(rows: TableRow[], titles: string[], out: string[]): number {
  const labelTitle = titles[0] ?? "";

  // Size the table by the widest row as well as by the declared columns.
  //
  // QBO does not guarantee one declared column per cell, and the gap is not
  // hypothetical: a sales-by-item report declares two columns and returns eight
  // cells on every row. Trusting the header list there would print one value and
  // drop six — two of which hold figures — which is the silent loss this whole
  // renderer exists to stop. A column QBO did not name gets an empty heading
  // rather than no column at all.
  const declared = Math.max(0, titles.length - 1);
  const widest = rows.reduce((max, r) => Math.max(max, r.values.length), 0);
  const valueTitles = Array.from(
    { length: Math.max(declared, widest) },
    (_, i) => titles[i + 1] ?? ""
  );

  const labels = rows.map(r => elideAccountName("  ".repeat(r.indent) + r.label, LABEL_CAP));
  const labelWidth = Math.max(labelTitle.length, ...labels.map(l => l.length));

  // Per-column widths, not one global maximum: a single wide heading would
  // otherwise pad every numeric column out to its length, which on a long
  // report is most of the output's bytes.
  const widths = valueTitles.map((title, i) =>
    Math.max(title.length, ...rows.map(r => (r.values[i] ?? "").length))
  );

  // trimEnd: padding the trailing columns of every short row is pure cost on a
  // report whose whole problem is size.
  const line = (label: string, values: string[]) =>
    `${label.padEnd(labelWidth)}  ${widths
      .map((w, i) => (values[i] ?? "").padStart(w))
      .join("  ")}`.trimEnd();

  // Every row is padded to the same width, so one row's cost is the whole
  // table's cost divided by its length — which makes the budget a row count
  // that can be applied before anything is emitted.
  const perRow = labelWidth + 2 + widths.reduce((sum, w) => sum + w + 2, 0);
  const affordable = Math.max(1, Math.floor(MAX_RENDER_CHARS / Math.max(1, perRow)));
  const shown = Math.min(rows.length, affordable);

  out.push("");
  // A report with no value columns and no column heading — a degenerate one QBO
  // returns when nothing matched — would otherwise open with a blank line.
  const heading = line(labelTitle, valueTitles);
  if (heading) out.push(heading);
  for (let i = 0; i < shown; i++) out.push(line(labels[i], rows[i].values));

  return shown;
}

export function renderGenericReport(
  report: QBReport,
  options: GenericReportOptions = {}
): string {
  const {
    label,
    detail = "summary",
    maxRows = DEFAULT_MAX_ROWS,
    overflowHint = "Raise max_rows or narrow the date range.",
  } = options;
  const header = report.Header ?? {};
  const lines: string[] = [];

  lines.push(header.ReportName || label || "Report");
  if (header.StartPeriod && header.EndPeriod) {
    lines.push(`Period: ${header.StartPeriod} to ${header.EndPeriod}`);
  } else if (header.EndPeriod) {
    lines.push(`As of: ${header.EndPeriod}`);
  }
  if (header.ReportBasis) lines.push(`Basis: ${header.ReportBasis}`);

  const titles = (report.Columns?.Column ?? []).map(c => clean(c.ColTitle));
  const rows: TableRow[] = [];
  const hiddenBySummary = { count: 0 };
  collect(report.Rows?.Row ?? [], 0, detail === "full", rows, hiddenBySummary);
  const hidden = hiddenBySummary.count;

  if (rows.length === 0) {
    lines.push("");
    lines.push("No rows.");
    return lines.join("\n");
  }

  const kept = rows.slice(0, Math.max(1, maxRows));
  const shown = renderTable(kept, titles, lines);

  if (shown < rows.length) {
    lines.push("");
    lines.push(`Showing ${shown} of ${rows.length} rows. ${overflowHint}`);
  }

  // Rows dropped by 'summary' never reach the count above, so without this the
  // response looks complete and nothing hints that the detail exists.
  if (detail === "summary" && hidden > 0) {
    lines.push("");
    lines.push(`${hidden} rows nested under these sections are not shown — pass detail_level="full" for them.`);
  }

  return lines.join("\n");
}
