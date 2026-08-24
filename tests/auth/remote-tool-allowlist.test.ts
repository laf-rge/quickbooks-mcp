import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { toolDefinitions } from "../../src/tools/index.js";

// src/lambda.ts advertises a filtered tool list over HTTP. Filtering tools/list
// is not access control on its own: the tools/call handler dispatches by name,
// so what is under test here is that the two lists are the same set — a name
// that is not advertised cannot be called either, even by a caller holding a
// valid token. The auth gate in front of all this is covered separately by
// lambda-fail-closed.test.ts; these cases all start from *past* it.

type GatewayResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
};
type Handler = (event: unknown) => Promise<GatewayResult>;
type LambdaModule = { handler: Handler; remoteToolNames: Set<string> };

type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

// All invented — no real tenant, audience or key set is involved.
const FAKE_AUDIENCE = "api://example-audience";
// Deliberately not a GUID-shaped issuer, so getAuthConfig() keeps it verbatim
// instead of expanding it into the two Azure AD tenant forms.
const FAKE_ISSUER = "https://auth.example.test/issuer";
const KEY_ID = "example-signing-key";

const ENV_KEYS = [
  "AWS_LAMBDA_FUNCTION_NAME",
  "MCP_AUTH_ALLOW_ANONYMOUS",
  "MCP_AUTH_JWKS_URI",
  "MCP_AUTH_AUDIENCE",
  "MCP_AUTH_ISSUER",
  "MCP_AUTH_SCOPE",
  "QBO_CREDENTIAL_MODE",
] as const;

let jwksServer: HttpServer;
let jwksUri: string;
let mintToken: () => Promise<string>;

before(async () => {
  // A throwaway key set served over loopback, so validateToken() runs for real
  // rather than being stubbed out. Without a genuinely valid token these tests
  // would prove only that unauthenticated callers are refused, which was never
  // in doubt.
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const keySet = JSON.stringify({ keys: [{ ...jwk, kid: KEY_ID, alg: "RS256", use: "sig" }] });

  jwksServer = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(keySet);
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  jwksUri = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/keys`;

  mintToken = () =>
    new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
      .setIssuer(FAKE_ISSUER)
      .setAudience(FAKE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
});

after(() => {
  jwksServer.close();
});

let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

let generation = 0;

/**
 * Import a fresh copy of the Lambda entry point against the current env.
 *
 * Auth config is read at module scope, so a plain import would hand back
 * whichever configuration happened to load first — see the same trick in
 * lambda-fail-closed.test.ts.
 */
async function loadLambda(): Promise<LambdaModule> {
  process.env.AWS_LAMBDA_FUNCTION_NAME = "example-mcp-fn";
  process.env.MCP_AUTH_JWKS_URI = jwksUri;
  process.env.MCP_AUTH_AUDIENCE = FAKE_AUDIENCE;
  process.env.MCP_AUTH_ISSUER = FAKE_ISSUER;

  const specifier = `../../src/lambda.js?allowlist=${generation++}`;
  return (await import(specifier)) as LambdaModule;
}

async function rpc(
  handler: Handler,
  body: Record<string, unknown>
): Promise<Record<string, any>> {
  const result = await handler({
    httpMethod: "POST",
    path: "/qb/mcp",
    headers: {
      host: "mcp.example.test",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${await mintToken()}`,
    },
    requestContext: { stage: "production" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    isBase64Encoded: false,
  });

  assert.equal(result.statusCode, 200, `expected the call to get past auth: ${result.body}`);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.error, undefined, `unexpected JSON-RPC error: ${result.body}`);
  return parsed.result;
}

function callTool(
  handler: Handler,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolCallResult> {
  return rpc(handler, {
    method: "tools/call",
    params: { name, arguments: args },
  }) as Promise<ToolCallResult>;
}

describe("remote tool allow-list", () => {
  it("refuses an authenticated call to a tool it does not advertise", async () => {
    const { handler } = await loadLambda();

    const result = await callTool(handler, "qbo_authenticate");

    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Unknown tool: qbo_authenticate");
    // The local-only OAuth handler must not have produced this: none of its
    // wording may appear in a remote response.
    assert.doesNotMatch(result.content[0].text, /credential mode|authoriz/i);
  });

  it("refuses it before executeTool runs, not inside it", async () => {
    const { handler } = await loadLambda();

    // executeTool validates arguments against the advertised schema before it
    // does anything else, and would reject this unknown parameter with
    // "Invalid arguments". Getting the unknown-tool answer instead is what
    // shows the call never got that far.
    const result = await callTool(handler, "qbo_authenticate", {
      not_a_real_parameter: "x",
    });

    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Unknown tool: qbo_authenticate");
    assert.doesNotMatch(result.content[0].text, /Invalid arguments/);
  });

  it("still dispatches an advertised tool through the same handler", async () => {
    const { handler } = await loadLambda();

    // A deliberately misspelled parameter: the reply can only come from
    // executeTool's argument validation, which proves the call was dispatched
    // rather than blocked. Validation runs before any credential lookup, so
    // this needs no QuickBooks connection.
    const result = await callTool(handler, "query", { qeury: "SELECT * FROM Account" });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid arguments/);
    assert.match(result.content[0].text, /Unknown parameter "qeury"/);
  });

  it("advertises exactly the set of tools it will call", async () => {
    const { handler, remoteToolNames } = await loadLambda();

    const listed = (await rpc(handler, { method: "tools/list" })) as {
      tools: Array<{ name: string }>;
    };
    const advertised = new Set(listed.tools.map((t) => t.name));

    assert.deepEqual(advertised, remoteToolNames);
    assert.ok(!advertised.has("qbo_authenticate"));
  });

  it("blocks every tool held back from the advertised list", async () => {
    const { handler, remoteToolNames } = await loadLambda();

    // Derived, not hardcoded: whatever src/lambda.ts filters out of the
    // advertised list is asserted to be uncallable too, so filtering another
    // tool later cannot quietly leave it reachable by name.
    const withheld = toolDefinitions
      .map((t) => t.name)
      .filter((name) => !remoteToolNames.has(name));

    assert.ok(withheld.length > 0, "expected at least one tool to be withheld remotely");

    for (const name of withheld) {
      const result = await callTool(handler, name);
      assert.equal(result.isError, true, `${name} was not rejected`);
      assert.equal(result.content[0].text, `Unknown tool: ${name}`);
    }
  });
});

describe("stdio surface", () => {
  // The filtering is a property of the remote transport only. Locally,
  // qbo_authenticate is the tool that establishes credentials in the first
  // place, so hiding or blocking it there would break setup entirely.
  async function connectStdioServer(): Promise<{ client: Client; close: () => Promise<void> }> {
    const { server } = await import("../../src/server.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it("still advertises qbo_authenticate", async () => {
    const { client, close } = await connectStdioServer();
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "qbo_authenticate"));
    } finally {
      await close();
    }
  });

  it("still dispatches qbo_authenticate to its handler", async () => {
    // Pinned to the non-local credential mode so the handler answers from its
    // first branch: no file access, no OAuth round trip, and a reply that only
    // that handler can produce.
    process.env.QBO_CREDENTIAL_MODE = "aws";

    const { client, close } = await connectStdioServer();
    try {
      const result = (await client.callTool({
        name: "qbo_authenticate",
        arguments: {},
      })) as unknown as ToolCallResult;

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /only works in local credential mode/);
      assert.doesNotMatch(result.content[0].text, /Unknown tool/);
    } finally {
      await close();
    }
  });
});
