import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toolDefinitions } from "../../src/tools/definitions.js";
import {
  validateToolArguments,
  suggestParameter,
  ToolArgumentError,
  type ToolSchema,
} from "../../src/tools/validate.js";

function schemaFor(toolName: string): ToolSchema {
  const definition = toolDefinitions.find((t) => t.name === toolName);
  assert.ok(definition, `no tool definition named ${toolName}`);
  return definition.inputSchema as unknown as ToolSchema;
}

function check(toolName: string, args: Record<string, unknown>): void {
  validateToolArguments(toolName, schemaFor(toolName), args);
}

function rejection(toolName: string, args: Record<string, unknown>): string {
  try {
    check(toolName, args);
  } catch (error) {
    assert.ok(error instanceof ToolArgumentError, "expected a ToolArgumentError");
    return error.message;
  }
  return assert.fail(`${toolName} accepted arguments it should have rejected`);
}

// A balanced two-line entry with nothing misspelled — the control for every
// rejection case below.
const VALID_LINES = [
  { account_name: "4000 Sales", amount: 100.0, posting_type: "Credit" },
  { account_name: "1000 Cash", amount: 100.0, posting_type: "Debit" },
];

describe("validateToolArguments", () => {
  it("accepts a well-formed call", () => {
    assert.doesNotThrow(() =>
      check("create_journal_entry", {
        txn_date: "2026-01-31",
        doc_number: "42",
        memo: "Fixture",
        lines: VALID_LINES,
        draft: true,
      })
    );
  });

  it("accepts a call that omits every optional parameter", () => {
    assert.doesNotThrow(() => check("get_balance_sheet", {}));
    assert.doesNotThrow(() => check("get_company_info", {}));
  });

  it("tolerates an undefined argument object", () => {
    assert.doesNotThrow(() => validateToolArguments("get_company_info", schemaFor("get_company_info"), undefined));
  });

  // The failure this whole module exists for: a date under the wrong key is not
  // an error, it is a journal entry posted on today's date instead.
  it("rejects an unknown parameter and names the one that was meant", () => {
    const message = rejection("create_journal_entry", {
      date: "2025-12-31",
      lines: VALID_LINES,
    });
    assert.match(message, /Unknown parameter "date"/);
    assert.match(message, /Did you mean "txn_date"\?/);
  });

  it("reports every unknown parameter in one pass", () => {
    const message = rejection("edit_journal_entry", {
      id: "1",
      date: "2025-12-31",
      journal_number: "42",
    });
    assert.match(message, /Unknown parameter "date".*Did you mean "txn_date"/);
    assert.match(message, /Unknown parameter "journal_number".*Did you mean "doc_number"/);
  });

  it("rejects a period parameter on an as-of report", () => {
    const message = rejection("get_balance_sheet", {
      start_date: "2026-01-01",
      end_date: "2026-01-31",
    });
    assert.match(message, /Unknown parameter "start_date"/);
    assert.match(message, /Did you mean "as_of_date"\?/);
  });

  it("rejects a filter the tool does not implement", () => {
    const message = rejection("list_accounts", { name_contains: "Sales" });
    assert.match(message, /Unknown parameter "name_contains"/);
    assert.match(message, /Valid parameters: account_type, active_only/);
  });

  it("rejects a missing required parameter", () => {
    const message = rejection("create_journal_entry", { lines: VALID_LINES });
    assert.match(message, /Missing required parameter "txn_date"/);
  });

  it("treats an explicit null as missing for a required parameter", () => {
    const message = rejection("query", { query: null });
    assert.match(message, /Missing required parameter "query"/);
  });

  it("rejects an unknown parameter nested in a line, with its position", () => {
    const message = rejection("create_journal_entry", {
      txn_date: "2026-01-31",
      lines: [VALID_LINES[0], { ...VALID_LINES[1], acount_name: "1000 Cash" }],
    });
    assert.match(message, /Unknown parameter "acount_name" at "lines\[1\]"/);
    assert.match(message, /Did you mean "account_name"\?/);
  });

  it("rejects a required line field that is missing", () => {
    const message = rejection("create_journal_entry", {
      txn_date: "2026-01-31",
      lines: [{ account_name: "4000 Sales", posting_type: "Credit" }],
    });
    assert.match(message, /Missing required parameter "lines\[0\]\.amount"/);
  });

  // Some MCP transports hand arrays over as JSON strings, and the write
  // handlers already parse them. Validation has to see through that too, or the
  // nested checks apply to half the calls.
  it("sees into an array delivered as a JSON string", () => {
    const message = rejection("create_journal_entry", {
      txn_date: "2026-01-31",
      lines: JSON.stringify([{ ...VALID_LINES[0], dept: "North" }]),
    });
    assert.match(message, /Unknown parameter "dept" at "lines\[0\]"/);
  });

  it("rejects an unknown key in a nested object parameter", () => {
    const message = rejection("create_customer", {
      display_name: "North Supply",
      bill_address: { line1: "1 Example Way", city: "Springfield", zip: "00000" },
    });
    assert.match(message, /Unknown parameter "zip" at "bill_address"/);
    assert.match(message, /Valid parameters: line1, .*postal_code/);
  });

  // An edit whose every field was misspelled leaves nothing but the id, and
  // used to report success with a SyncToken that never advanced.
  it("rejects an edit with nothing to change", () => {
    const message = rejection("edit_journal_entry", { id: "1", draft: false });
    assert.match(message, /no fields to change/);
    assert.match(message, /txn_date, memo, doc_number, lines/);
  });

  it("allows an edit that changes exactly one field", () => {
    assert.doesNotThrow(() => check("edit_journal_entry", { id: "1", memo: "Corrected" }));
  });

  it("does not treat a read tool's single argument as an edit", () => {
    assert.doesNotThrow(() => check("get_journal_entry", { id: "1" }));
    assert.doesNotThrow(() => check("delete_entity", { entity_type: "journal_entry", id: "1" }));
  });

  it("validates every declared tool against its own documented example", () => {
    // Guards against a schema that declares `required` keys it does not define
    // as properties — such a tool could never be called successfully.
    for (const definition of toolDefinitions) {
      const schema = definition.inputSchema as unknown as ToolSchema;
      for (const key of schema.required ?? []) {
        assert.ok(
          schema.properties && key in schema.properties,
          `${definition.name} requires "${key}" but does not declare it`
        );
      }
    }
  });
});

describe("suggestParameter", () => {
  it("prefers a candidate sharing a whole word over a shorter edit distance", () => {
    assert.equal(suggestParameter("date", ["txn_date", "draft", "memo"]), "txn_date");
  });

  it("matches a truncated name by prefix", () => {
    assert.equal(suggestParameter("account", ["account_name", "amount"]), "account_name");
  });

  it("declines to guess at an abbreviation it cannot resolve", () => {
    // "dept" shares no word with "department_name" and is not a prefix of it;
    // listing the valid names is more use than a confident wrong guess.
    assert.equal(suggestParameter("dept", ["department_name", "amount"]), undefined);
  });

  it("matches a single-character typo", () => {
    assert.equal(suggestParameter("memoo", ["memo", "lines"]), "memo");
  });

  it("returns nothing when no candidate is close", () => {
    assert.equal(suggestParameter("name_contains", ["account_type", "active_only"]), undefined);
  });

  it("is deterministic when candidates tie", () => {
    const valid = ["alpha_date", "beta_date"];
    assert.equal(suggestParameter("date", valid), suggestParameter("date", [...valid].reverse()));
  });
});
