import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatQboError, extractQboFault, extractHttpStatus } from "../../src/utils/errors.js";

// How an axios rejection reaches us through node-quickbooks: a generic Error
// whose message names only the status, with the Fault hidden on response.data.
function axiosLikeError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

const VALIDATION_FAULT = {
  Fault: {
    Error: [
      {
        Message: "Object Not Found",
        Detail: "Object Not Found : Something you are trying to use has been made inactive.",
        code: "610",
      },
    ],
    type: "ValidationFault",
  },
  time: "2026-06-15T00:00:00.000-07:00",
};

describe("formatQboError", () => {
  it("surfaces the fault buried under an axios response", () => {
    const text = formatQboError(axiosLikeError(400, VALIDATION_FAULT));
    assert.match(text, /Request failed with status code 400/);
    assert.match(text, /ValidationFault/);
    assert.match(text, /\[610\]/);
    assert.match(text, /Object Not Found/);
    assert.match(text, /made inactive/);
  });

  it("reads a fault that is the rejection value itself", () => {
    const text = formatQboError(VALIDATION_FAULT);
    assert.match(text, /\[610\] Object Not Found/);
    assert.doesNotMatch(text, /\{/); // formatted, not a JSON dump
  });

  it("handles the lowercase spelling QBO sometimes returns", () => {
    const text = formatQboError({
      fault: { error: [{ message: "Invalid Reference Id", code: "2500" }], type: "ValidationFault" },
    });
    assert.match(text, /\[2500\] Invalid Reference Id/);
  });

  it("lists every fault entry when there is more than one", () => {
    const text = formatQboError(
      axiosLikeError(400, {
        Fault: {
          Error: [
            { Message: "First problem", code: "100" },
            { Message: "Second problem", code: "200" },
          ],
          type: "ValidationFault",
        },
      })
    );
    assert.match(text, /\[100\] First problem/);
    assert.match(text, /\[200\] Second problem/);
  });

  it("parses a fault body that arrived as raw text", () => {
    const text = formatQboError(axiosLikeError(400, JSON.stringify(VALIDATION_FAULT)));
    assert.match(text, /\[610\] Object Not Found/);
  });

  it("does not repeat the detail when it duplicates the message", () => {
    const text = formatQboError({
      Fault: { Error: [{ Message: "Same text", Detail: "Same text", code: "5010" }] },
    });
    assert.equal(text.match(/Same text/g)?.length, 1);
  });

  it("falls back to the plain message when there is no fault", () => {
    assert.equal(formatQboError(new Error("socket hang up")), "socket hang up");
  });

  it("survives a circular object with no fault", () => {
    const circular: Record<string, unknown> = { note: "no fault here" };
    circular.self = circular;
    const text = formatQboError(circular);
    assert.match(text, /no fault here/);
  });

  it("survives values that are not objects at all", () => {
    assert.equal(formatQboError("plain string"), "plain string");
    assert.equal(formatQboError(undefined), "undefined");
    assert.equal(formatQboError(null), "null");
  });

  it("does not throw on a malformed fault", () => {
    assert.doesNotThrow(() => formatQboError({ Fault: "not an object" }));
    assert.doesNotThrow(() => formatQboError({ Fault: { Error: ["not an object"] } }));
    assert.doesNotThrow(() => formatQboError({ Fault: { Error: null, type: 7 } }));
  });

  it("names the status when the fault is the whole rejection value", () => {
    const thrown = Object.assign({ ...VALIDATION_FAULT }, { status: 400 });
    assert.match(formatQboError(thrown), /HTTP 400/);
  });
});

describe("extractQboFault", () => {
  it("normalizes casing across both spellings", () => {
    const fromAxios = extractQboFault(axiosLikeError(400, VALIDATION_FAULT));
    assert.equal(fromAxios?.type, "ValidationFault");
    assert.equal(fromAxios?.errors[0].code, "610");
    assert.equal(fromAxios?.errors[0].message, "Object Not Found");

    const lower = extractQboFault({ fault: { error: [{ message: "m", code: "1" }] } });
    assert.equal(lower?.errors[0].message, "m");
  });

  it("returns undefined when there is nothing fault-shaped", () => {
    assert.equal(extractQboFault(new Error("boom")), undefined);
    assert.equal(extractQboFault({ Fault: {} }), undefined);
    assert.equal(extractQboFault(42), undefined);
  });
});

describe("extractHttpStatus", () => {
  it("finds the status wherever the thrower left it", () => {
    assert.equal(extractHttpStatus(axiosLikeError(429, {})), 429);
    assert.equal(extractHttpStatus(Object.assign(new Error("x"), { status: 503 })), 503);
    assert.equal(extractHttpStatus(new Error("x")), undefined);
  });
});
