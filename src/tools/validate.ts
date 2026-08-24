// Argument validation against the declared tool input schemas.
//
// The MCP low-level Server hands `request.params.arguments` straight to the
// handler — it does not check them against the `inputSchema` advertised by
// tools/list. Handlers destructure the fields they know about, so anything
// misspelled is simply not there: the call succeeds and quietly does something
// other than what was asked. A journal entry created with `date` instead of
// `txn_date` posts on today's date; an edit whose every field is misspelled
// reports success while changing nothing; a report asked for at `start_date`
// instead of `as_of_date` comes back as of today.
//
// So the schema is enforced here, before dispatch: unknown keys are rejected
// with a suggestion, and declared `required` keys must actually be present.

export interface ToolSchema {
  type?: string;
  properties?: Record<string, ToolSchema>;
  required?: string[];
  items?: ToolSchema;
}

/**
 * Keys an `edit_*` tool accepts that do not, by themselves, change anything:
 * they address the record or control the write rather than describe an edit.
 */
const NON_MUTATING_EDIT_KEYS = new Set(["id", "draft", "confirm", "expected_total"]);

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const curr = [i];
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[cols - 1];
}

function tokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Closest name by edit distance alone.
 *
 * suggestParameter is the wrong ranking for a value drawn from a fixed list.
 * It puts shared whole words first, which is right for parameter names — `date`
 * really does mean `txn_date` — but wrong for an enum whose members are
 * variations on one phrase: against `aged_payable` it prefers
 * `aged_payable_detail`, which shares two words, over `aged_payables`, which is
 * a single character away and obviously what was meant.
 */
export function suggestClosest(unknown: string, valid: string[]): string | undefined {
  const lower = unknown.toLowerCase();
  let best: { name: string; distance: number } | undefined;

  for (const name of valid) {
    const distance = levenshtein(lower, name.toLowerCase());
    // Far enough away and a suggestion is noise rather than help.
    if (distance > Math.max(2, Math.floor(name.length / 2))) continue;
    if (!best || distance < best.distance || (distance === best.distance && name < best.name)) {
      best = { name, distance };
    }
  }

  return best?.name;
}

/**
 * Best valid name for a misspelling, or undefined when nothing is close.
 *
 * Edit distance alone is not enough for the misspellings that actually happen
 * here, because the real names are compounds: `date` → `txn_date` is four edits
 * apart but shares the whole word. Shared underscore-separated tokens rank
 * first, edit distance breaks the tie.
 */
export function suggestParameter(unknown: string, valid: string[]): string | undefined {
  const unknownTokens = new Set(tokens(unknown));
  let best: { name: string; shared: number; distance: number } | undefined;

  for (const name of valid) {
    const lower = name.toLowerCase();
    const shared = tokens(name).filter((t) => unknownTokens.has(t)).length;
    const distance = levenshtein(unknown.toLowerCase(), lower);
    // A truncated name ("account" for "account_name") shares no whole word and
    // is far apart by edit distance, but one is a prefix of the other.
    const prefix =
      unknown.length >= 3 &&
      (lower.startsWith(unknown.toLowerCase()) || unknown.toLowerCase().startsWith(lower));
    // A candidate qualifies if it shares a whole word, is a truncation of one,
    // or is a near-miss typo.
    const closeEnough =
      shared > 0 || prefix || distance <= Math.max(1, Math.floor(name.length / 3));
    if (!closeEnough) continue;
    if (
      !best ||
      shared > best.shared ||
      (shared === best.shared && distance < best.distance) ||
      (shared === best.shared && distance === best.distance && name < best.name)
    ) {
      best = { name, shared, distance };
    }
  }

  return best?.name;
}

function describePath(path: string[], key: string): string {
  return [...path, key].join(".").replace(/\.\[/g, "[");
}

/**
 * Arrays sometimes arrive as JSON strings over an MCP transport (the write
 * handlers already defend against it). Parse for validation only, so a typo
 * inside a stringified line is still caught; a string that is not JSON is left
 * to the handler.
 */
function coerceForValidation(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collect(
  toolName: string,
  schema: ToolSchema,
  value: unknown,
  path: string[],
  errors: string[]
): void {
  if (!isPlainObject(value)) return;

  const properties = schema.properties;
  // No declared properties means the shape is open by design — nothing to check.
  if (!properties) return;

  const valid = Object.keys(properties);

  for (const key of Object.keys(value)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
    const suggestion = suggestParameter(key, valid);
    const where = path.length ? ` at "${path.join(".").replace(/\.\[/g, "[")}"` : "";
    errors.push(
      `Unknown parameter "${key}"${where} for tool ${toolName}.` +
        (suggestion ? ` Did you mean "${suggestion}"?` : "") +
        ` Valid parameters: ${valid.join(", ")}.`
    );
  }

  for (const key of schema.required ?? []) {
    const provided = value[key];
    if (provided === undefined || provided === null) {
      errors.push(`Missing required parameter "${describePath(path, key)}" for tool ${toolName}.`);
    }
  }

  for (const [key, child] of Object.entries(properties)) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    const provided = coerceForValidation(raw);

    if (child.items && Array.isArray(provided)) {
      provided.forEach((item, index) => {
        collect(toolName, child.items!, item, [...path, `${key}[${index}]`], errors);
      });
      continue;
    }

    if (child.properties && isPlainObject(provided)) {
      collect(toolName, child, provided, [...path, key], errors);
    }
  }
}

/**
 * Throw unless `args` matches the tool's declared input schema.
 *
 * Checks unknown keys and required keys, at every nesting level. Types and
 * enums are deliberately left to the handlers and to QuickBooks, so that a
 * value the handler already normalizes is not rejected here.
 */
export function validateToolArguments(
  toolName: string,
  schema: ToolSchema | undefined,
  args: Record<string, unknown> | undefined
): void {
  if (!schema) return;
  const value = args ?? {};
  const errors: string[] = [];

  collect(toolName, schema, value, [], errors);

  // An edit addressed to a record with nothing to change is the same failure in
  // a different costume: every field misspelled leaves only `id`, and the write
  // still reports success. Catch it before the round trip.
  if (errors.length === 0 && toolName.startsWith("edit_") && schema.properties) {
    const changed = Object.keys(value).filter(
      (key) => !NON_MUTATING_EDIT_KEYS.has(key) && value[key] !== undefined
    );
    if (changed.length === 0) {
      const changeable = Object.keys(schema.properties).filter(
        (key) => !NON_MUTATING_EDIT_KEYS.has(key)
      );
      errors.push(
        `${toolName} was called with no fields to change. ` +
          `Provide at least one of: ${changeable.join(", ")}.`
      );
    }
  }

  if (errors.length > 0) {
    throw new ToolArgumentError(errors.join("\n"));
  }
}
