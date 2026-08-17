// Output mode utilities for stdio vs HTTP transport
// In stdio mode: write full data to temp files, return filepath reference
// In HTTP mode: return data inline (no filesystem access in Lambda)

import { writeReport } from "./files.js";

export type OutputMode = "stdio" | "http";

let currentOutputMode: OutputMode = "stdio";

export function setOutputMode(mode: OutputMode): void {
  currentOutputMode = mode;
}

export function isHttpMode(): boolean {
  return currentOutputMode === "http";
}

type ToolResult = { content: Array<{ type: string; text: string }> };

export interface OutputReportOptions {
  /**
   * Whether HTTP mode appends the raw payload as a second content block.
   *
   * Defaults to true because most callers are entity reads (get_bill,
   * get_deposit, …) whose payload *is* the answer. The report tools pass false
   * unless asked: their rendered summary already carries the numbers, so the
   * raw copy is largely redundant and roughly doubles the response.
   *
   * There is deliberately no "truncated" middle ground — a sliced
   * JSON.stringify is invalid JSON, unparseable by any consumer and only
   * partly legible to a model, while still costing most of the tokens.
   */
  includeRaw?: boolean;
}

/**
 * Return report data in the appropriate format for the current transport.
 * - stdio: writes to temp file, appends filepath to summary
 * - http: returns summary, plus inline JSON data when includeRaw
 */
export function outputReport(
  reportType: string,
  data: unknown,
  summary: string,
  options: OutputReportOptions = {}
): ToolResult {
  if (isHttpMode()) {
    const { includeRaw = true } = options;
    if (!includeRaw) {
      return { content: [{ type: "text", text: summary }] };
    }
    return {
      content: [
        { type: "text", text: summary },
        { type: "text", text: JSON.stringify(data) },
      ],
    };
  }

  const filepath = writeReport(reportType, data);
  return {
    content: [{ type: "text", text: `${summary}\n\nFull data: ${filepath}` }],
  };
}
