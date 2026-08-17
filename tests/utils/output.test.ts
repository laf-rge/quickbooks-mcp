import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { outputReport, setOutputMode } from "../../src/utils/output.js";

const DATA = { Rows: { Row: [{ ColData: [{ value: "1000 Cash" }, { value: "250.00" }] }] } };
const SUMMARY = "TrialBalance\nTotal: 250.00";

after(() => setOutputMode("stdio"));

describe("outputReport — includeRaw", () => {
  it("returns the summary alone when raw is declined", () => {
    setOutputMode("http");
    const result = outputReport("trial-balance", DATA, SUMMARY, { includeRaw: false });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].text, SUMMARY);
  });

  it("appends the payload when raw is requested", () => {
    setOutputMode("http");
    const result = outputReport("trial-balance", DATA, SUMMARY, { includeRaw: true });
    assert.equal(result.content.length, 2);
    assert.deepEqual(JSON.parse(result.content[1].text), DATA);
  });

  it("still appends the payload when unspecified", () => {
    // The report tools opt out explicitly; the other callers are entity reads
    // whose payload IS the answer, so the default must stay raw-inclusive.
    setOutputMode("http");
    const result = outputReport("bill-1", DATA, SUMMARY);
    assert.equal(result.content.length, 2);
  });

  it("ignores includeRaw in stdio mode, where the payload goes to a file", () => {
    setOutputMode("stdio");
    const result = outputReport("trial-balance", DATA, SUMMARY, { includeRaw: false });
    assert.equal(result.content.length, 1);
    assert.match(result.content[0].text, /Full data: /);
  });
});
