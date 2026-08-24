import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// The fail-closed guard in src/lambda.ts is resolved at MODULE scope — that is
// the whole point of it, since a cold start should decide once whether this
// container is safe to serve. So every case here has to (re)import the module
// under a different environment, which means a cache-busting specifier: a plain
// `import` would hand back whichever configuration happened to load first and
// silently make all but one of these tests vacuous.

type GatewayResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
};
type Handler = (event: unknown) => Promise<GatewayResult>;

// All invented — nothing here points at a real tenant, audience or key set.
const FAKE_JWKS_URI = "https://auth.example.test/keys";
const FAKE_AUDIENCE = "api://example-audience";
const FAKE_ISSUER = "https://auth.example.test/issuer";

const AUTH_ENV_KEYS = [
  "AWS_LAMBDA_FUNCTION_NAME",
  "MCP_AUTH_ALLOW_ANONYMOUS",
  "MCP_AUTH_JWKS_URI",
  "MCP_AUTH_AUDIENCE",
  "MCP_AUTH_ISSUER",
  "MCP_AUTH_SCOPE",
] as const;

let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  // Snapshot and clear, so neither the ambient environment nor a previous case
  // can leak in. Without this the results depend on test ordering.
  snapshot = {};
  for (const key of AUTH_ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of AUTH_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

let generation = 0;

/**
 * Import a fresh copy of the Lambda entry point against the current env.
 *
 * The FATAL cold-start log is captured rather than printed: it is part of the
 * contract (it is how the cause reaches CloudWatch), and asserting on it beats
 * letting it scroll past in the test output.
 */
async function loadHandler(): Promise<{ handler: Handler; errors: string[] }> {
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const specifier = `../../src/lambda.js?generation=${generation++}`;
    const mod = (await import(specifier)) as { handler: Handler };
    return { handler: mod.handler, errors };
  } finally {
    console.error = realError;
  }
}

function postEvent(): unknown {
  return {
    httpMethod: "POST",
    path: "/qb/mcp",
    headers: { host: "mcp.example.test", "content-type": "application/json" },
    requestContext: { stage: "production" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    isBase64Encoded: false,
  };
}

function getEvent(): unknown {
  return {
    httpMethod: "GET",
    path: "/qb/mcp",
    headers: { host: "mcp.example.test" },
    requestContext: { stage: "production" },
  };
}

function optionsEvent(): unknown {
  return {
    httpMethod: "OPTIONS",
    path: "/qb/mcp",
    headers: { host: "mcp.example.test" },
    requestContext: { stage: "production" },
  };
}

function setFullAuthConfig(): void {
  process.env.MCP_AUTH_JWKS_URI = FAKE_JWKS_URI;
  process.env.MCP_AUTH_AUDIENCE = FAKE_AUDIENCE;
  process.env.MCP_AUTH_ISSUER = FAKE_ISSUER;
}

describe("lambda auth fail-closed guard", () => {
  it("refuses requests in Lambda when no auth vars are set", async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "example-mcp-fn";

    const { handler, errors } = await loadHandler();
    const result = await handler(postEvent());

    assert.equal(result.statusCode, 503);
    assert.equal(JSON.parse(result.body).error, "server_misconfigured");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^FATAL: running in Lambda with no auth configured/);
  });

  it("refuses requests in Lambda on a PARTIAL config", async () => {
    // The case that motivated this guard: one env var typo'd or dropped in
    // Terraform. getAuthConfig() returns null for two-of-three just as it does
    // for none of three, so before the guard this served the books openly.
    process.env.AWS_LAMBDA_FUNCTION_NAME = "example-mcp-fn";
    process.env.MCP_AUTH_JWKS_URI = FAKE_JWKS_URI;
    process.env.MCP_AUTH_AUDIENCE = FAKE_AUDIENCE;
    // MCP_AUTH_ISSUER deliberately absent

    const { handler } = await loadHandler();
    const result = await handler(postEvent());

    assert.equal(result.statusCode, 503);
    assert.equal(JSON.parse(result.body).error, "server_misconfigured");
  });

  it("refuses a GET in Lambda when misconfigured, before metadata is served", async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "example-mcp-fn";

    const { handler } = await loadHandler();
    const result = await handler(getEvent());

    assert.equal(result.statusCode, 503);
  });

  it("still answers warmer pings when misconfigured", async () => {
    // A misconfiguration should not also present as a dead container: the
    // warmer short-circuit runs first, on purpose.
    process.env.AWS_LAMBDA_FUNCTION_NAME = "example-mcp-fn";

    const { handler } = await loadHandler();
    const result = await handler({ warmer: true });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body, "warmer");
  });

  it("leaves the 401 path untouched when auth IS configured", async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "example-mcp-fn";
    setFullAuthConfig();

    const { handler, errors } = await loadHandler();
    const result = await handler(postEvent());

    // 401, not 503: a correctly configured server rejects the caller, not
    // itself. No token is validated here, so no key set is fetched.
    assert.equal(result.statusCode, 401);
    assert.equal(JSON.parse(result.body).error, "unauthorized");
    assert.equal(errors.length, 0);
  });

  it("serves resource metadata when auth IS configured", async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "example-mcp-fn";
    setFullAuthConfig();

    const { handler } = await loadHandler();
    const result = await handler(getEvent());

    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).resource, "https://mcp.example.test/qb/mcp");
  });

  it("honours the explicit MCP_AUTH_ALLOW_ANONYMOUS opt-out", async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "example-mcp-fn";
    process.env.MCP_AUTH_ALLOW_ANONYMOUS = "true";

    const { handler, errors } = await loadHandler();

    // Reaches the ordinary unauthenticated behaviour rather than the guard:
    // 405 "Auth not configured" on GET, 200 on preflight.
    const getResult = await handler(getEvent());
    assert.notEqual(getResult.statusCode, 503);
    assert.equal(getResult.statusCode, 405);

    const optionsResult = await handler(optionsEvent());
    assert.equal(optionsResult.statusCode, 200);
    assert.equal(errors.length, 0);
  });

  it("treats any value other than \"true\" as no opt-out", async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "example-mcp-fn";
    process.env.MCP_AUTH_ALLOW_ANONYMOUS = "1";

    const { handler } = await loadHandler();
    const result = await handler(postEvent());

    assert.equal(result.statusCode, 503);
  });

  it("does not change local development, where there is no Lambda runtime", async () => {
    // No AWS_LAMBDA_FUNCTION_NAME and no auth vars — the stdio/local shape.
    const { handler, errors } = await loadHandler();

    const getResult = await handler(getEvent());
    assert.equal(getResult.statusCode, 405);

    const optionsResult = await handler(optionsEvent());
    assert.equal(optionsResult.statusCode, 200);

    assert.equal(errors.length, 0);
  });
});
