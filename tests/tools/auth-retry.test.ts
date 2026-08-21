import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runWithAuthRetry } from "../../src/tools/auth-retry.js";
import { newAttemptRecord, withWriteTracking, markWriteIssued } from "../../src/client/write-barrier.js";
import { promisify, promisifyWrite } from "../../src/client/promisify.js";

// An expired token as it arrives through a node-quickbooks method: a generic
// axios rejection with the AuthenticationFault nested on response.data.
function authError(): Error {
  return Object.assign(new Error("Request failed with status code 401"), {
    response: {
      status: 401,
      data: {
        Fault: {
          Error: [{ Message: "message=AuthenticationFailed", code: "3200" }],
          type: "AUTHENTICATION",
        },
      },
    },
  });
}

function validationError(): Error {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: {
      status: 400,
      data: { Fault: { Error: [{ Message: "Invalid Reference Id", code: "2500" }] }, type: "ValidationFault" },
    },
  });
}

const sleep = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("runWithAuthRetry", () => {
  it("retries once with fresh credentials when nothing was written", async () => {
    let attempts = 0;
    let refreshes = 0;

    const outcome = await runWithAuthRetry(async () => {
      attempts++;
      if (attempts === 1) throw authError();
      return "second attempt worked";
    }, () => { refreshes++; });

    assert.deepEqual(outcome, { status: "ok", value: "second attempt worked" });
    assert.equal(attempts, 2);
    assert.equal(refreshes, 1);
  });

  it("does NOT retry once a write has gone out — the duplicate-post guard", async () => {
    let attempts = 0;
    let refreshes = 0;

    // Stands in for a create handler: resolve refs, post, then fail. Whether the
    // post landed is unknowable from here, so a second run could book it twice.
    const outcome = await runWithAuthRetry(async () => {
      attempts++;
      await sleep();
      markWriteIssued();
      throw authError();
    }, () => { refreshes++; });

    assert.equal(attempts, 1, "the handler must not run a second time");
    assert.equal(refreshes, 0);
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") {
      assert.equal(outcome.retryBlockedByWrite, true);
      assert.equal(outcome.retried, false);
    }
  });

  it("retries a write tool that failed before it posted anything", async () => {
    let attempts = 0;

    // The common case: the token is rejected while loading the account cache, so
    // no transaction exists and replaying is free.
    const outcome = await runWithAuthRetry(async () => {
      attempts++;
      if (attempts === 1) throw authError();
      markWriteIssued();
      return "bill created";
    }, () => {});

    assert.deepEqual(outcome, { status: "ok", value: "bill created" });
    assert.equal(attempts, 2);
  });

  it("keeps one call's write from blocking another call's retry", async () => {
    // A module-level flag would leak between overlapping tool calls; the record
    // has to be per-attempt.
    let readAttempts = 0;

    const write = runWithAuthRetry(async () => {
      markWriteIssued();
      await sleep();
      throw authError();
    }, () => {});

    const read = runWithAuthRetry(async () => {
      readAttempts++;
      await sleep();
      if (readAttempts === 1) throw authError();
      return "read worked";
    }, () => {});

    const [writeOutcome, readOutcome] = await Promise.all([write, read]);

    assert.equal(writeOutcome.status, "failed");
    assert.equal(readOutcome.status, "ok");
    assert.equal(readAttempts, 2);
  });

  it("does not retry a failure that is not about credentials", async () => {
    let attempts = 0;
    let refreshes = 0;

    const outcome = await runWithAuthRetry(async () => {
      attempts++;
      throw validationError();
    }, () => { refreshes++; });

    assert.equal(attempts, 1);
    assert.equal(refreshes, 0);
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") {
      assert.equal(outcome.retried, false);
      assert.equal(outcome.retryBlockedByWrite, false);
    }
  });

  it("reports the retry's own error when the second attempt fails too", async () => {
    const outcome = await runWithAuthRetry(async () => {
      throw validationError();
    }, () => {});
    assert.equal(outcome.status, "failed");

    let attempts = 0;
    const second = await runWithAuthRetry(async () => {
      attempts++;
      if (attempts === 1) throw authError();
      throw new Error("still broken");
    }, () => {});

    assert.equal(second.status, "failed");
    if (second.status === "failed") {
      assert.equal(second.retried, true);
      assert.equal((second.error as Error).message, "still broken");
    }
  });
});

describe("write barrier", () => {
  it("is armed by promisifyWrite and left alone by promisify", async () => {
    const read = newAttemptRecord();
    await withWriteTracking(read, () => promisify<string>((cb) => cb(null, "ok")));
    assert.equal(read.writeIssued, false);

    const write = newAttemptRecord();
    await withWriteTracking(write, () => promisifyWrite<string>((cb) => cb(null, "ok")));
    assert.equal(write.writeIssued, true);
  });

  it("is armed before the request resolves, not after it succeeds", async () => {
    // The dangerous window opens when the bytes leave, so a write that never
    // comes back still counts.
    const record = newAttemptRecord();
    await assert.rejects(
      withWriteTracking(record, () =>
        promisifyWrite<string>((cb) => cb(new Error("connection reset"), ""))
      )
    );
    assert.equal(record.writeIssued, true);
  });

  it("survives being marked deep in an async call chain", async () => {
    const record = newAttemptRecord();
    await withWriteTracking(record, async () => {
      await sleep();
      await (async () => {
        await sleep();
        markWriteIssued();
      })();
    });
    assert.equal(record.writeIssued, true);
  });
});

// Walk up from the compiled test to the checked-out repo.
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("could not locate the repository root");
    dir = parent;
  }
  return dir;
}

describe("write call sites", () => {
  it("all go through promisifyWrite, so none can be replayed by the retry", () => {
    // The barrier only protects the writes that announce themselves. A new
    // handler that reaches for plain promisify would quietly opt its create back
    // into being retried, and nothing else in the suite would notice — so the
    // convention is asserted against the source itself.
    const handlerDir = path.join(repoRoot(), "src", "tools", "handlers");
    const writeCall = /client\.(?:create|update)[A-Za-z]+\(|config\.deleteMethod/;
    const unguarded: string[] = [];

    for (const file of readdirSync(handlerDir).filter((f) => f.endsWith(".ts"))) {
      const lines = readFileSync(path.join(handlerDir, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!writeCall.test(line)) return;
        // The promisify call opening the expression sits within two lines of it.
        const context = lines.slice(Math.max(0, i - 2), i + 1).join("\n");
        if (!context.includes("promisifyWrite")) unguarded.push(`${file}:${i + 1}`);
      });
    }

    assert.deepEqual(unguarded, [], `write calls not wrapped in promisifyWrite: ${unguarded.join(", ")}`);
  });
});
