// Lambda entry point for QuickBooks MCP server (Streamable HTTP transport)
// Deployed behind API Gateway — handles OAuth token validation and proxies
// the OAuth authorization flow to Azure AD for MCP client compatibility.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { setOutputMode } from "./utils/output.js";
import { toolDefinitions, executeTool } from "./tools/index.js";
import { getAuthConfig, validateToken } from "./auth/token-validator.js";

// Set HTTP output mode at module load (before any handlers run)
setOutputMode("http");

// Filter out qbo_authenticate — not relevant for remote/Lambda usage
const remoteToolDefinitions = toolDefinitions.filter(
  (t) => t.name !== "qbo_authenticate"
);

// Load auth config once at module level (cached across warm invocations)
const authConfig = getAuthConfig();

// Azure AD OAuth endpoints (derived from MCP_AUTH_SERVER_URL)
const AUTH_SERVER_URL = process.env.MCP_AUTH_SERVER_URL || "";
const AZURE_TENANT_BASE = AUTH_SERVER_URL.replace(/\/v2\.0\/?$/, "");
const AZURE_AUTHORIZE_URL = `${AZURE_TENANT_BASE}/oauth2/v2.0/authorize`;
const AZURE_TOKEN_URL = `${AZURE_TENANT_BASE}/oauth2/v2.0/token`;
const MCP_SCOPE = process.env.MCP_AUTH_AUDIENCE && process.env.MCP_AUTH_SCOPE
  ? `${process.env.MCP_AUTH_AUDIENCE}/${process.env.MCP_AUTH_SCOPE}`
  : "";

// Create MCP server
function createServer(): Server {
  const server = new Server(
    { name: "quickbooks-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: remoteToolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return executeTool(name, args as Record<string, unknown>);
  });

  return server;
}

// Unified event shape — handles both REST API v1 and HTTP API v2 formats
interface APIGatewayEvent {
  // v1 (REST API) fields
  httpMethod?: string;
  path?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  // v2 (HTTP API) fields
  requestContext?: {
    http?: { method: string; path: string };
    stage?: string; // present in both v1 and v2
  };
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface APIGatewayResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};

function getMethodAndPath(event: APIGatewayEvent): { method: string; path: string } {
  const method = event.httpMethod ?? event.requestContext?.http?.method ?? "GET";
  const path = event.path ?? event.requestContext?.http?.path ?? "/";
  return { method, path };
}

/**
 * Build the public-facing URL for a given path on this API.
 * With custom domain: host is mcp.wagonermanagement.com, no stage prefix needed.
 * With API Gateway domain: host is xxx.execute-api..., stage prefix needed.
 */
function getPublicUrl(event: APIGatewayEvent, overridePath?: string): string {
  const host = event.headers["host"] || event.headers["Host"] || "localhost";
  const path = overridePath ?? event.path ?? event.requestContext?.http?.path ?? "/";
  const isApiGatewayDomain = host.includes("execute-api");
  const stage = event.requestContext?.stage;
  const fullPath = isApiGatewayDomain && event.httpMethod && stage
    ? `/${stage}${path}`
    : path;
  return `https://${host}${fullPath}`;
}

/**
 * Convert API Gateway event to Web Standard Request
 */
function toWebRequest(event: APIGatewayEvent, method: string): Request {
  const url = getPublicUrl(event);

  let body: string | undefined;
  if (event.body) {
    body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf-8")
      : event.body;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value) headers.set(key, value);
  }

  return new Request(url, {
    method,
    headers,
    body: method !== "GET" && method !== "HEAD" ? body : undefined,
  });
}

/**
 * Convert Web Standard Response to API Gateway result
 */
async function toGatewayResult(response: Response): Promise<APIGatewayResult> {
  const headers: Record<string, string> = { ...CORS_HEADERS };
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
    isBase64Encoded: false,
  };
}

function extractBearerToken(headers: Record<string, string | undefined>): string | null {
  const auth = headers["authorization"] || headers["Authorization"];
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// OAuth proxy handlers — makes our server act as an OAuth AS proxy to Azure AD
// so MCP clients that expect /authorize and /token on the server URL work.
// ---------------------------------------------------------------------------

/**
 * GET /.well-known/oauth-authorization-server
 * Returns OAuth Authorization Server Metadata pointing to our proxy endpoints.
 */
function oauthServerMetadata(event: APIGatewayEvent): APIGatewayResult {
  const metadata = {
    issuer: AUTH_SERVER_URL,
    authorization_endpoint: getPublicUrl(event, "/authorize"),
    token_endpoint: getPublicUrl(event, "/token"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: MCP_SCOPE ? [MCP_SCOPE, "offline_access"] : [],
  };

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
    isBase64Encoded: false,
  };
}

/**
 * GET /authorize — redirect to Azure AD's authorize endpoint.
 * Passes through all query params, replacing scope with our Azure AD scope.
 */
function handleAuthorize(event: APIGatewayEvent): APIGatewayResult {
  const params = new URLSearchParams();
  const qs = event.queryStringParameters || {};
  for (const [key, value] of Object.entries(qs)) {
    if (!value) continue;
    if (key === "scope") {
      // Replace client scope with our Azure AD scope, preserving offline_access
      // so Azure AD issues a refresh token for longer sessions
      const requestedScopes = value.split(" ");
      const hasOfflineAccess = requestedScopes.includes("offline_access");
      const scope = MCP_SCOPE
        ? hasOfflineAccess ? `${MCP_SCOPE} offline_access` : MCP_SCOPE
        : value;
      params.set("scope", scope);
    } else if (key === "prompt" && value === "consent") {
      // Don't forward prompt=consent — our tenant policy blocks consent for
      // unverified publisher apps (like Claude's DCR client). Admin consent
      // is already granted, so we can safely use "select_account" instead.
      params.set("prompt", "select_account");
    } else {
      params.set(key, value);
    }
  }
  // Ensure scope is set even if not in the original request
  if (!params.has("scope") && MCP_SCOPE) {
    params.set("scope", `${MCP_SCOPE} offline_access`);
  }

  const redirectUrl = `${AZURE_AUTHORIZE_URL}?${params.toString()}`;

  return {
    statusCode: 302,
    headers: { ...CORS_HEADERS, Location: redirectUrl },
    body: "",
    isBase64Encoded: false,
  };
}

/**
 * POST /token — proxy the token exchange to Azure AD.
 * Forwards the request body, replacing scope with our Azure AD scope.
 */
async function handleToken(event: APIGatewayEvent): Promise<APIGatewayResult> {
  let body = event.body || "";
  if (event.isBase64Encoded) {
    body = Buffer.from(body, "base64").toString("utf-8");
  }

  // Parse form body and replace scope, preserving offline_access for refresh tokens
  const params = new URLSearchParams(body);
  if (MCP_SCOPE) {
    const currentScope = params.get("scope") || "";
    const hasOfflineAccess = currentScope.split(" ").includes("offline_access");
    params.set("scope", hasOfflineAccess ? `${MCP_SCOPE} offline_access` : MCP_SCOPE);
  }

  const response = await fetch(AZURE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const responseBody = await response.text();

  return {
    statusCode: response.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": response.headers.get("content-type") || "application/json",
    },
    body: responseBody,
    isBase64Encoded: false,
  };
}

/**
 * GET /qb/mcp — Protected Resource Metadata (RFC 9728)
 */
function resourceMetadataResponse(event: APIGatewayEvent): APIGatewayResult {
  const resourceUrl = getPublicUrl(event);
  const resourceName = process.env.MCP_RESOURCE_NAME || "QuickBooks MCP Server";
  const scopesSupported = MCP_SCOPE ? [MCP_SCOPE, "offline_access"] : [];

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      resource: resourceUrl,
      authorization_servers: AUTH_SERVER_URL ? [AUTH_SERVER_URL] : [],
      scopes_supported: scopesSupported,
      bearer_methods_supported: ["header"],
      resource_name: resourceName,
    }),
    isBase64Encoded: false,
  };
}

/**
 * 401 response with discovery hints
 */
function unauthorized(event: APIGatewayEvent, description: string): APIGatewayResult {
  const resourceUrl = getPublicUrl(event);
  return {
    statusCode: 401,
    headers: {
      ...CORS_HEADERS,
      "WWW-Authenticate": `Bearer resource_metadata="${resourceUrl}"`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      error: "unauthorized",
      error_description: description,
      resource_metadata: resourceUrl,
    }),
    isBase64Encoded: false,
  };
}

// ---------------------------------------------------------------------------
// Main handler — routes by path and method
// ---------------------------------------------------------------------------

export async function handler(event: APIGatewayEvent): Promise<APIGatewayResult> {
  // Short-circuit scheduled warmer pings (e.g. EventBridge rule with payload
  // {"warmer": true}) so they don't exercise auth or QB API code paths.
  if ((event as unknown as { warmer?: boolean }).warmer === true) {
    return { statusCode: 200, headers: {}, body: "warmer", isBase64Encoded: false };
  }

  const { method, path } = getMethodAndPath(event);

  // CORS preflight for any path
  if (method === "OPTIONS") {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: "",
      isBase64Encoded: false,
    };
  }

  // Route by path
  if (path === "/.well-known/oauth-authorization-server" && method === "GET") {
    return oauthServerMetadata(event);
  }

  if (path === "/authorize" && method === "GET") {
    return handleAuthorize(event);
  }

  if (path === "/token" && method === "POST") {
    return handleToken(event);
  }

  // MCP endpoint paths: /qb/mcp (with custom domain) or the raw path
  // GET → resource metadata, POST → MCP request
  if (method === "GET") {
    if (authConfig) {
      return resourceMetadataResponse(event);
    }
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "method_not_allowed", error_description: "Auth not configured" }),
      isBase64Encoded: false,
    };
  }

  if (method === "POST") {
    if (authConfig) {
      const token = extractBearerToken(event.headers);
      if (!token) {
        return unauthorized(event, "Bearer token required");
      }
      const result = await validateToken(token, authConfig);
      if (!result.valid) {
        return unauthorized(event, result.error);
      }
    }

    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);

    try {
      const webRequest = toWebRequest(event, method);
      const webResponse = await transport.handleRequest(webRequest);
      return toGatewayResult(webResponse);
    } finally {
      await transport.close();
      await server.close();
    }
  }

  return {
    statusCode: 405,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ error: "method_not_allowed" }),
    isBase64Encoded: false,
  };
}
