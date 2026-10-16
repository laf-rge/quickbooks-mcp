import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { toolDefinitions } from "../../src/tools/definitions.js";

// Clients group a connector's tools into read-only and write permissions by
// these hints, so a tool without them, or with the wrong readOnlyHint, lands in
// the wrong bucket. The HTTP transport is covered in
// tests/auth/remote-tool-allowlist.test.ts.

type Annotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

const annotationsOf = (name: string): Annotations | undefined =>
  (toolDefinitions.find((t) => t.name === name) as { annotations?: Annotations } | undefined)?.annotations;

const WRITE_NAME = /^(create|edit|delete|receive)_|_authenticate$/;

describe("tool annotations", () => {
  it("gives every tool a unique title and all four hints", () => {
    const titles = new Set<string>();
    for (const { name } of toolDefinitions) {
      const a = annotationsOf(name);
      assert.ok(a, `${name} has no annotations`);
      assert.ok((a.title ?? "").length >= 8, `${name} title`);
      assert.ok(!titles.has(a.title!), `${name} duplicate title`);
      titles.add(a.title!);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        assert.equal(typeof a[hint], "boolean", `${name} ${hint}`);
      }
      assert.equal(a.openWorldHint, true, `${name} openWorldHint`);
    }
  });

  it("marks exactly the write-shaped names as not read-only", () => {
    for (const { name } of toolDefinitions) {
      assert.equal(annotationsOf(name)!.readOnlyHint, !WRITE_NAME.test(name), name);
    }
  });

  it("marks deletes destructive and nothing else", () => {
    for (const { name } of toolDefinitions) {
      assert.equal(annotationsOf(name)!.destructiveHint, name.startsWith("delete_"), name);
    }
  });

  it("never marks a create idempotent", () => {
    for (const { name } of toolDefinitions.filter((t) => /^(create|receive)_/.test(t.name))) {
      assert.equal(annotationsOf(name)!.idempotentHint, false, name);
    }
  });

  it("reaches the client through tools/list on the stdio server", async () => {
    const { server } = await import("../../src/server.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, toolDefinitions.length);
      for (const t of tools) {
        assert.deepEqual(t.annotations, annotationsOf(t.name), t.name);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
