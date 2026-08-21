import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type QuickBooks from "node-quickbooks";

import { handleQuery } from "../../src/tools/handlers/query.js";

type Callback = (err: unknown, result: unknown) => void;

// node-quickbooks find* methods call back with the axios rejection itself, which
// is why the fault sits at response.data rather than on the error.
function nestedFaultError(status: number, fault: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: fault },
  });
}

const NON_FILTERABLE_FAULT = {
  Fault: {
    Error: [
      {
        Message: "Invalid query",
        Detail: "QueryParserError: property name: DepartmentRef is not queryable.",
        code: "4000",
      },
    ],
    type: "ValidationFault",
  },
};

const AUTH_FAULT = {
  Fault: {
    Error: [{ Message: "message=AuthenticationFailed", code: "3200" }],
    type: "AUTHENTICATION",
  },
};

function failingClient(error: unknown) {
  let calls = 0;
  const client = {
    findBills: (_criteria: string, cb: Callback) => {
      calls++;
      cb(error, error);
    },
  } as unknown as QuickBooks;
  return { client, callCount: () => calls };
}

describe("handleQuery error handling", () => {
  it("names the filterable fields when the fault is nested on the rejection", async () => {
    const { client } = failingClient(nestedFaultError(400, NON_FILTERABLE_FAULT));

    const result = await handleQuery(client, {
      query: "select * from Bill where DepartmentRef = '1'",
    });

    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /Query failed \(code 4000\)/);
    assert.match(text, /Filterable fields for Bill:/);
    assert.match(text, /VendorRef/);
    // The suggestion only fires if the offending field was identified from the
    // detail, which is only readable once the nested fault is found at all.
    assert.match(text, /query_account_transactions/);
  });

  it("hands an expired token back to the dispatcher instead of answering it", async () => {
    // An auth fault must not be dressed up as a query problem: the retry with
    // refreshed credentials lives in executeTool and only sees what is thrown.
    const { client } = failingClient(nestedFaultError(401, AUTH_FAULT));

    await assert.rejects(
      handleQuery(client, { query: "select * from Bill" }),
      /401/
    );
  });

  it("does not retry a validation fault before giving up", async () => {
    const { client, callCount } = failingClient(nestedFaultError(400, NON_FILTERABLE_FAULT));
    await handleQuery(client, { query: "select * from Bill where DepartmentRef = '1'" });
    assert.equal(callCount(), 1);
  });
});
