import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isQBError, extractQBErrorInfo } from "../../src/types/quickbooks.js";

// node-quickbooks hands its callback the axios rejection untouched, so this —
// not a top-level Fault — is the shape a failed call arrives in.
function nodeQuickbooksError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

const NON_FILTERABLE_FAULT = {
  Fault: {
    Error: [
      {
        Message: "Invalid query",
        Detail: "QueryParserError: Encountered \" <PROPERTY> \"DepartmentRef\"\" at line 1.",
        code: "4000",
      },
    ],
    type: "ValidationFault",
  },
};

describe("isQBError", () => {
  it("finds the fault nested on an axios rejection", () => {
    assert.equal(isQBError(nodeQuickbooksError(400, NON_FILTERABLE_FAULT)), true);
  });

  it("still finds a fault that is the rejection value itself", () => {
    assert.equal(isQBError(NON_FILTERABLE_FAULT), true);
  });

  it("finds a fault that arrived as an unparsed response body", () => {
    assert.equal(isQBError(nodeQuickbooksError(400, JSON.stringify(NON_FILTERABLE_FAULT))), true);
  });

  it("says no when nothing fault-shaped is reachable", () => {
    assert.equal(isQBError(new Error("socket hang up")), false);
    assert.equal(isQBError(nodeQuickbooksError(500, { note: "gateway blew up" })), false);
    assert.equal(isQBError("plain string"), false);
    assert.equal(isQBError(null), false);
  });
});

describe("extractQBErrorInfo", () => {
  it("reads code, message and detail out of a nested fault", () => {
    const info = extractQBErrorInfo(nodeQuickbooksError(400, NON_FILTERABLE_FAULT));
    assert.equal(info.code, "4000");
    assert.equal(info.message, "Invalid query");
    assert.match(info.detail ?? "", /QueryParserError/);
  });

  it("handles the lowercase spelling node-quickbooks sometimes emits", () => {
    const info = extractQBErrorInfo({ fault: { error: [{ message: "Object Not Found", code: "610" }] } });
    assert.equal(info.code, "610");
    assert.equal(info.message, "Object Not Found");
  });

  it("returns nothing rather than throwing when there is no fault", () => {
    assert.deepEqual(extractQBErrorInfo(new Error("boom")), {});
  });
});
