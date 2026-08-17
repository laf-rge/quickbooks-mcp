// Column helpers shared by the report renderers.

import { QBReportColData } from "../types/index.js";

export function labelOf(cols: QBReportColData[] | undefined): string {
  return cols?.[0]?.value?.trim() || "";
}

// A report summarized by department/class has one column per member plus a
// trailing total; a plain report has a single value column. Either way the
// rightmost column is the one worth showing on a single line.
export function pickValue(cols: QBReportColData[] | undefined, multiColumn: boolean): string | null {
  const values = (cols ?? []).slice(1).map(c => c.value || "0");
  if (values.length === 0) return null;
  return multiColumn ? values[values.length - 1] : values[0];
}

// Every value column, positionally. Index i here lines up with index i of the
// report's column titles, so an empty cell must stay an empty string rather than
// being dropped — collapsing it would shift later values under the wrong header.
export function allValues(cols: QBReportColData[] | undefined): string[] {
  return (cols ?? []).slice(1).map(c => c.value || "");
}
