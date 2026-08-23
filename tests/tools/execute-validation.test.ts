import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeTool } from "../../src/tools/index.js";

// These calls carry no credentials and never should need any: validation runs
// before the dispatcher asks for a QuickBooks client, so a misspelled argument
// is refused without a round trip. If validation ever moves after the client
// lookup, these tests fail with an auth error instead of an argument error —
// which is the signal we want.
describe("executeTool argument validation", () => {
  it("refuses an unknown parameter before reaching QuickBooks", async () => {
    const result = await executeTool("create_journal_entry", {
      date: "2025-12-31",
      lines: [
        { account_name: "4000 Sales", amount: 100.0, posting_type: "Credit" },
        { account_name: "1000 Cash", amount: 100.0, posting_type: "Debit" },
      ],
      draft: false,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid arguments/);
    assert.match(result.content[0].text, /Unknown parameter "date"/);
    assert.match(result.content[0].text, /Did you mean "txn_date"\?/);
  });

  it("refuses a missing required parameter", async () => {
    const result = await executeTool("get_journal_entry", {});

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Missing required parameter "id"/);
  });

  it("refuses an edit that would change nothing", async () => {
    const result = await executeTool("edit_journal_entry", { id: "1", draft: false });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no fields to change/);
  });

  it("still rejects an unknown tool name outright", async () => {
    await assert.rejects(() => executeTool("not_a_tool", {}), /Unknown tool: not_a_tool/);
  });
});
