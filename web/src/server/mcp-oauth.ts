/**
 * OAuth 2.1 for the hosted MCP server, per the MCP authorization spec: public
 * clients only (PKCE S256, no secrets), dynamic client registration, one-time
 * codes, short-lived access tokens with rotating refresh tokens.
 *
 * The MCP Worker serves the metadata, `/register`, `/authorize` and `/token`;
 * the web app serves the consent screen (it has the Clerk session) and mints
 * the code. Both use this module, so it only has relative imports.
 *
 * An OAuth grant is an `mcp_tokens` row with a `client_id`: settings lists it
 * as a connection, and revoking it kills both its access and refresh token.
 */

import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { pid } from '../db/ids';
import * as schema from '../db/schema';
import { type McpScope, MCP_SCOPES, parseMcpScopes } from './mcp-scopes';
import { MCP_TOKEN_TTL_MS } from './mcp-token-policy';

type Db = DrizzleD1Database<typeof schema>;

export const OAUTH_CODE_TTL_MS = 60 * 1_000;
export const OAUTH_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1_000;
export const OAUTH_REFRESH_TOKEN_TTL_MS = MCP_TOKEN_TTL_MS;
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 100;

export interface OAuthError {
  error: string;
  error_description?: string;
}

function oauthError(error: string, description?: string): OAuthError {
  return description ? { error, error_description: description } : { error };
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `BASE64URL(SHA256(verifier))`, the PKCE S256 challenge. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:']);

/**
 * Redirect URIs a client may register: `https:` anywhere, `http:` only on
 * loopback (RFC 8252 §7.3), or a native app's private-use scheme
 * (`cursor://…`). Never a fragment, and never a scheme that runs code.
 */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_000) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || value.includes('#')) return false;
  if (url.protocol === 'https:') return Boolean(url.hostname);
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !BLOCKED_SCHEMES.has(url.protocol);
}

/** Exact match, except that loopback redirects may use any port (RFC 8252 §7.3). */
export function redirectUriMatches(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    if (a.protocol !== 'http:' || b.protocol !== 'http:' || !LOOPBACK_HOSTS.has(a.hostname)) return false;
    a.port = '';
    b.port = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

/** The `scope` parameter. Missing means read; anything unknown is an error. */
export function parseScopeParam(scope: string | null | undefined): McpScope[] | null {
  const requested = (scope ?? '').split(/\s+/).filter(Boolean);
  if (!requested.length) return ['read'];
  if (requested.some((entry) => !(MCP_SCOPES as readonly string[]).includes(entry))) return null;
  return MCP_SCOPES.filter((entry) => entry === 'read' || requested.includes(entry));
}

/** `uri` with `params` added to its query string. */
export function withQuery(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.href;
}

// --- Dynamic client registration (RFC 7591) --------------------------------

export interface RegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  client_id_issued_at: number;
  token_endpoint_auth_method: 'none';
  grant_types: string[];
  response_types: string[];
}

export async function registerClient(db: Db, body: unknown, now = Date.now()): Promise<RegisteredClient | OAuthError> {
  if (typeof body !== 'object' || body === null) return oauthError('invalid_client_metadata', 'body must be a JSON object');
  const record = body as Record<string, unknown>;
  const uris = record.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECT_URIS) {
    return oauthError('invalid_redirect_uri', `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`);
  }
  if (!uris.every(isAllowedRedirectUri)) {
    return oauthError('invalid_redirect_uri', 'redirect URIs must be https, http on loopback, or an app scheme');
  }
  const grantTypes = record.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grantTypes) || grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    return oauthError('invalid_client_metadata', 'only authorization_code and refresh_token grants are supported');
  }
  const responseTypes = record.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
    return oauthError('invalid_client_metadata', 'only the code response type is supported');
  }
  const rawName = typeof record.client_name === 'string' ? record.client_name.trim() : '';
  const name = (rawName || 'MCP client').slice(0, MAX_CLIENT_NAME);
  const id = `mcpc_${randomHex(16)}`;
  await db.insert(schema.oauthClients).values({
    id,
    name,
    redirectUrisJson: JSON.stringify(uris),
    createdAt: now,
  });
  return {
    client_id: id,
    client_name: name,
    redirect_uris: uris,
    client_id_issued_at: Math.floor(now / 1000),
    // Every client is public: a secret it asked for would be one we never check.
    token_endpoint_auth_method: 'none',
    grant_types: grantTypes as string[],
    response_types: ['code'],
  };
}

// --- Authorization request -------------------------------------------------

export interface AuthorizationParams {
  client_id?: string | null;
  redirect_uri?: string | null;
  response_type?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  scope?: string | null;
  state?: string | null;
}

export type ValidatedAuthorization =
  | {
      ok: true;
      clientId: string;
      clientName: string;
      redirectUri: string;
      codeChallenge: string;
      scopes: McpScope[];
      state?: string;
    }
  /** The client or redirect URI can't be trusted: show the error, never redirect. */
  | { ok: false; redirect: false; error: OAuthError }
  /** The redirect URI is trusted: send the error back to the client. */
  | { ok: false; redirect: true; redirectTo: string; error: OAuthError };

export function authorizationParams(search: URLSearchParams): AuthorizationParams {
  const keys = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'state'] as const;
  return Object.fromEntries(keys.map((key) => [key, search.get(key)]));
}

export async function validateAuthorization(db: Db, params: AuthorizationParams): Promise<ValidatedAuthorization> {
  const clientId = params.client_id ?? '';
  const client = clientId
    ? (await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, clientId)).limit(1))[0]
    : undefined;
  if (!client) return { ok: false, redirect: false, error: oauthError('invalid_client', 'unknown client_id') };

  const registered = parseStringArray(client.redirectUrisJson);
  const given = params.redirect_uri ?? '';
  const redirectUri = given
    ? registered.some((uri) => redirectUriMatches(uri, given)) ? given : null
    : registered.length === 1 ? registered[0] : null;
  if (!redirectUri) {
    return { ok: false, redirect: false, error: oauthError('invalid_request', 'redirect_uri is not registered for this client') };
  }

  const state = params.state ?? undefined;
  const fail = (error: OAuthError): ValidatedAuthorization => ({
    ok: false,
    redirect: true,
    redirectTo: withQuery(redirectUri, { ...error, state }),
    error,
  });
  if (params.response_type !== 'code') return fail(oauthError('unsupported_response_type', 'response_type must be code'));
  const challenge = params.code_challenge ?? '';
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return fail(oauthError('invalid_request', 'a PKCE code_challenge is required'));
  if (params.code_challenge_method !== 'S256') return fail(oauthError('invalid_request', 'code_challenge_method must be S256'));
  const scopes = parseScopeParam(params.scope);
  if (!scopes) return fail(oauthError('invalid_scope', `supported scopes: ${MCP_SCOPES.join(' ')}`));

  return { ok: true, clientId: client.id, clientName: client.name, redirectUri, codeChallenge: challenge, scopes, state };
}

/**
 * The user approved: mint a one-time code for the scopes they granted (never
 * more than the client asked for) and return where to send the browser.
 */
export async function approveAuthorization(
  db: Db,
  args: { request: Extract<ValidatedAuthorization, { ok: true }>; userId: string; scopes: McpScope[]; issuer: string },
  now = Date.now(),
): Promise<string> {
  const granted = MCP_SCOPES.filter((scope) => args.request.scopes.includes(scope) && args.scopes.includes(scope));
  const code = `oc_${randomHex(32)}`;
  await db.insert(schema.oauthCodes).values({
    codeHash: await sha256Hex(code),
    clientId: args.request.clientId,
    userId: args.userId,
    redirectUri: args.request.redirectUri,
    codeChallenge: args.request.codeChallenge,
    scopesJson: JSON.stringify(granted.length ? granted : ['read']),
    createdAt: now,
    expiresAt: now + OAUTH_CODE_TTL_MS,
  });
  return withQuery(args.request.redirectUri, { code, state: args.request.state, iss: args.issuer });
}

export function denyAuthorization(request: Extract<ValidatedAuthorization, { ok: true }>, issuer: string): string {
  return withQuery(request.redirectUri, {
    error: 'access_denied',
    error_description: 'the user denied access',
    state: request.state,
    iss: issuer,
  });
}

// --- Token endpoint --------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function newTokens(now: number) {
  return {
    accessToken: `nt_${randomHex(32)}`,
    refreshToken: `rt_${randomHex(32)}`,
    expiresAt: now + OAUTH_ACCESS_TOKEN_TTL_MS,
    refreshExpiresAt: now + OAUTH_REFRESH_TOKEN_TTL_MS,
  };
}

function tokenResponse(tokens: ReturnType<typeof newTokens>, scopes: McpScope[]): TokenResponse {
  return {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(OAUTH_ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: tokens.refreshToken,
    scope: scopes.join(' '),
  };
}

export async function exchangeToken(db: Db, form: URLSearchParams, now = Date.now()): Promise<TokenResponse | OAuthError> {
  const grantType = form.get('grant_type');
  if (grantType === 'authorization_code') return await exchangeCode(db, form, now);
  if (grantType === 'refresh_token') return await refresh(db, form, now);
  return oauthError('unsupported_grant_type');
}

async function exchangeCode(db: Db, form: URLSearchParams, now: number): Promise<TokenResponse | OAuthError> {
  const code = form.get('code') ?? '';
  const verifier = form.get('code_verifier') ?? '';
  const clientId = form.get('client_id') ?? '';
  if (!code || !clientId) return oauthError('invalid_request', 'code and client_id are required');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError('invalid_grant', 'a valid code_verifier is required');

  // Spend the code first, in one statement, so it can only ever be used once.
  const used = await db
    .update(schema.oauthCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(schema.oauthCodes.codeHash, await sha256Hex(code)),
        isNull(schema.oauthCodes.usedAt),
        gt(schema.oauthCodes.expiresAt, now),
      ),
    )
    .returning();
  const row = used[0];
  if (!row) return oauthError('invalid_grant', 'the code is invalid, expired or already used');
  if (row.clientId !== clientId) return oauthError('invalid_grant', 'the code was issued to another client');
  const redirectUri = form.get('redirect_uri');
  if (redirectUri !== null && redirectUri !== row.redirectUri) return oauthError('invalid_grant', 'redirect_uri does not match');
  if ((await pkceChallenge(verifier)) !== row.codeChallenge) return oauthError('invalid_grant', 'PKCE verification failed');

  const client = (await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, clientId)).limit(1))[0];
  if (!client) return oauthError('invalid_client');

  const scopes = parseMcpScopes(row.scopesJson);
  const tokens = newTokens(now);
  const id = pid('mcp');
  await db.insert(schema.mcpTokens).values({
    id,
    userId: row.userId,
    tokenHash: await sha256Hex(tokens.accessToken),
    name: client.name,
    scopesJson: JSON.stringify(scopes),
    createdAt: now,
    expiresAt: tokens.expiresAt,
    clientId,
    refreshHash: await sha256Hex(tokens.refreshToken),
    refreshExpiresAt: tokens.refreshExpiresAt,
  });
  // Re-authorizing the same client replaces its earlier connection rather than piling up rows.
  await db
    .update(schema.mcpTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.mcpTokens.userId, row.userId),
        eq(schema.mcpTokens.clientId, clientId),
        ne(schema.mcpTokens.id, id),
        isNull(schema.mcpTokens.revokedAt),
      ),
    );
  return tokenResponse(tokens, scopes);
}

async function refresh(db: Db, form: URLSearchParams, now: number): Promise<TokenResponse | OAuthError> {
  const refreshToken = form.get('refresh_token') ?? '';
  const clientId = form.get('client_id') ?? '';
  if (!refreshToken || !clientId) return oauthError('invalid_request', 'refresh_token and client_id are required');

  const refreshHash = await sha256Hex(refreshToken);
  const requested = form.get('scope');
  if (requested !== null) {
    // Checked before rotating, so a bad scope doesn't cost the client its refresh token.
    const current = (
      await db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.refreshHash, refreshHash)).limit(1)
    )[0];
    const asked = parseScopeParam(requested);
    if (current && (!asked || asked.some((scope) => !parseMcpScopes(current.scopesJson).includes(scope)))) {
      return oauthError('invalid_scope', 'a refresh cannot add scopes');
    }
  }

  const tokens = newTokens(now);
  // Rotate in one statement: the old refresh token stops working the moment a new one exists.
  const rotated = await db
    .update(schema.mcpTokens)
    .set({
      tokenHash: await sha256Hex(tokens.accessToken),
      refreshHash: await sha256Hex(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
    })
    .where(
      and(
        eq(schema.mcpTokens.refreshHash, refreshHash),
        eq(schema.mcpTokens.clientId, clientId),
        isNull(schema.mcpTokens.revokedAt),
        gt(schema.mcpTokens.refreshExpiresAt, now),
      ),
    )
    .returning();
  const row = rotated[0];
  if (!row) return oauthError('invalid_grant', 'the refresh token is invalid, expired or revoked');
  const scopes = parseMcpScopes(row.scopesJson);
  return tokenResponse(tokens, scopes);
}

// --- Metadata --------------------------------------------------------------

export function protectedResourceMetadata(origin: string) {
  return {
    resource: origin,
    authorization_servers: [origin],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Eavesy',
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: [...MCP_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
  };
}

function parseStringArray(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}
