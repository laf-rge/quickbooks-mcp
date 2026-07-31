// Pagination utilities for QuickBooks queries

import QuickBooks from "node-quickbooks";
import { PaginationParams, PaginatedQueryResult, QBQueryResponse } from "../types/index.js";
import { promisify } from "../client/promisify.js";
import { qboQuery } from "../client/rest.js";
import { withRetry } from "../client/throttle.js";
import { isHttpMode } from "../utils/output.js";

// Pagination constants
export const BATCH_SIZE = 1000;
export const SAFETY_LIMIT = 10000;
export const WARNING_THRESHOLD = 5000;

// Entity type for paginated results
interface PaginatedEntity {
  Id?: string;
  [key: string]: unknown;
}

// Helper to extract entities from QB query response
function extractEntitiesFromResponse(result: unknown): { entityKey: string; entities: PaginatedEntity[] } {
  const response = result as QBQueryResponse<PaginatedEntity> | undefined;
  const queryResponse = response?.QueryResponse;
  if (!queryResponse) {
    return { entityKey: 'Unknown', entities: [] };
  }

  const entityKey = Object.keys(queryResponse).find(k => Array.isArray(queryResponse[k]));
  if (!entityKey) {
    return { entityKey: 'Unknown', entities: [] };
  }

  return { entityKey, entities: queryResponse[entityKey] ?? [] };
}

// Parse pagination params from query string
export function parsePaginationFromQuery(query: string): PaginationParams {
  let maxResults = isHttpMode() ? 100 : 1000; // Lower default for HTTP (results go into context)
  let startPosition: number | null = null;

  // Extract MAXRESULTS
  const maxMatch = query.match(/MAXRESULTS\s+(\d+)/i);
  if (maxMatch) {
    maxResults = parseInt(maxMatch[1], 10);
  }

  // Extract STARTPOSITION (presence disables auto-pagination)
  const startMatch = query.match(/STARTPOSITION\s+(\d+)/i);
  if (startMatch) {
    startPosition = parseInt(startMatch[1], 10);
  }

  // Extract criteria (everything after FROM Entity) and strip pagination clauses
  const criteriaMatch = query.match(/FROM\s+\w+\s*(.*)/i);
  let baseCriteria = criteriaMatch ? criteriaMatch[1].trim() : '';

  // Strip pagination clauses from criteria
  baseCriteria = baseCriteria
    .replace(/\s*MAXRESULTS\s+\d+/gi, '')
    .replace(/\s*STARTPOSITION\s+\d+/gi, '')
    .trim()
    .replace(/;?\s*$/, '');

  return { maxResults, startPosition, baseCriteria };
}

// Fetches one page of an entity query. Given a criteria string (WHERE clause
// plus STARTPOSITION/MAXRESULTS), returns the raw QueryResponse envelope.
export type QueryFetcher = (criteria: string) => Promise<unknown>;

// Fetch through the node-quickbooks wrapper method for an entity.
export function finderFetcher(client: QuickBooks, finderMethod: keyof QuickBooks): QueryFetcher {
  const method = client[finderMethod] as (
    criteria: string,
    cb: (err: Error | null, result: unknown) => void
  ) => void;
  // Bind to client to preserve 'this' context
  return (criteria) => promisify<unknown>((cb) => method.call(client, criteria, cb));
}

// Fetch through the raw REST query endpoint, for entities node-quickbooks has no
// wrapper method for. Builds the same statement its find* methods do.
export function rawFetcher(client: QuickBooks, entity: string): QueryFetcher {
  return (criteria) => qboQuery(client, `select * from ${entity} ${criteria}`.trim());
}

// Resolve the cheapest fetcher for an entity: the wrapper method when one
// exists, raw REST otherwise. Wrapped in retry so a throttled or dropped page
// doesn't surface as an entity that quietly returned nothing.
export function fetcherForEntity(client: QuickBooks, entity: string, finderMethod: keyof QuickBooks): QueryFetcher {
  const fetcher = typeof client[finderMethod] === "function"
    ? finderFetcher(client, finderMethod)
    : rawFetcher(client, entity);
  return (criteria) => withRetry(() => fetcher(criteria));
}

// Paginated query fetcher
export async function paginatedQuery(
  fetcher: QueryFetcher,
  pagination: PaginationParams
): Promise<PaginatedQueryResult> {
  const { maxResults, startPosition, baseCriteria } = pagination;

  // Build criteria with optional base (WHERE clause, etc.)
  const buildCriteria = (start: number, limit: number) => {
    const parts = [];
    if (baseCriteria) parts.push(baseCriteria);
    parts.push(`STARTPOSITION ${start}`);
    parts.push(`MAXRESULTS ${limit}`);
    return parts.join(' ');
  };

  // If STARTPOSITION is specified, user wants explicit control - single fetch, no auto-pagination
  if (startPosition !== null) {
    const fetchLimit = Math.min(maxResults, BATCH_SIZE);
    const criteria = buildCriteria(startPosition, fetchLimit);
    const result = await fetcher(criteria);
    const { entityKey, entities } = extractEntitiesFromResponse(result);

    // Probe for more data if we got exactly what we requested
    let hasMore = false;
    let apiCalls = 1;
    if (entities.length >= fetchLimit) {
      const probePosition = startPosition + entities.length;
      const probeCriteria = buildCriteria(probePosition, 1);
      const probeResult = await fetcher(probeCriteria);
      apiCalls++;
      const probeEntities = extractEntitiesFromResponse(probeResult).entities;
      hasMore = probeEntities.length > 0;
    }

    return {
      entities,
      entityKey,
      apiCalls,
      truncated: false,
      startPositionSpecified: true,
      hasMore,
      returnedCount: entities.length,
      requestedLimit: fetchLimit
    };
  }

  // Auto-pagination mode
  const allEntities: PaginatedEntity[] = [];
  let apiCalls = 0;
  let currentPosition = 1; // QB uses 1-based indexing
  let entityKey = 'Unknown';
  const targetLimit = Math.min(maxResults, SAFETY_LIMIT);
  let truncated = false;

  while (allEntities.length < targetLimit) {
    const remaining = targetLimit - allEntities.length;
    const batchSize = Math.min(BATCH_SIZE, remaining);

    const criteria = buildCriteria(currentPosition, batchSize);
    const result = await fetcher(criteria);
    apiCalls++;

    const extracted = extractEntitiesFromResponse(result);
    if (extracted.entityKey !== 'Unknown') entityKey = extracted.entityKey;
    const batchEntities = extracted.entities;

    if (batchEntities.length === 0) {
      // No more results
      break;
    }

    allEntities.push(...batchEntities);
    currentPosition += batchEntities.length;

    // If we got fewer than requested, there are no more results
    if (batchEntities.length < batchSize) {
      break;
    }

    // Safety check: if we've hit the safety limit, stop
    if (allEntities.length >= SAFETY_LIMIT) {
      truncated = true;
      break;
    }
  }

  // Check if we hit the safety limit while more data might exist
  if (maxResults > SAFETY_LIMIT && allEntities.length >= SAFETY_LIMIT) {
    truncated = true;
  }

  // Probe for more data if we got exactly what we requested (and not truncated by safety limit)
  let hasMore = truncated; // If truncated, we know there's more
  if (!truncated && allEntities.length >= targetLimit && allEntities.length < SAFETY_LIMIT) {
    const probeCriteria = buildCriteria(currentPosition, 1);
    const probeResult = await fetcher(probeCriteria);
    apiCalls++;
    const probeEntities = extractEntitiesFromResponse(probeResult).entities;
    hasMore = probeEntities.length > 0;
  }

  return {
    entities: allEntities,
    entityKey,
    apiCalls,
    truncated,
    startPositionSpecified: false,
    hasMore,
    returnedCount: allEntities.length,
    requestedLimit: targetLimit
  };
}
