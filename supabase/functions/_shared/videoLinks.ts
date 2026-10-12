// Client video links: how a link's token is made, checked and turned into a URL - pure code (Web Crypto only), shared by the issuing Edge
// Function (issue-report-video-links) and by the tests, so what is tested is exactly what runs.
//
// THE DESIGN IN ONE PARAGRAPH. A link is a row in report_video_links that stores ONLY sha256(token). The token is
//   base64url( HMAC-SHA256( VIDEO_LINK_SECRET, "kc-video-link-v1:" + link id ) )      (43 URL-safe characters = 256 bits)
// where VIDEO_LINK_SECRET exists only in the issuing function's environment - never in the database, the browser or any log. So:
//   * the database cannot produce a token (a database leak yields no usable link);
//   * the issuing function can RE-DERIVE a link's token from its id, compare sha256(token) with the stored hash, and REUSE the link
//     (the same URL goes into every PDF for that video until it is close to expiry or revoked);
//   * if the secret is ever changed the stored hashes stop matching, and fresh links are issued automatically.
// Tokens and full URLs containing them must never be logged; nothing in this file logs anything.

const TOKEN_CONTEXT = 'kc-video-link-v1:';
const MIN_SECRET_LENGTH = 32;

/** The only token shape that can exist: 43 URL-safe base64 characters. Anything else is rejected before any lookup. */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export class LinkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkConfigError';
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The token for a link id. Deterministic for a given secret and id; unguessable without the secret. */
export async function deriveToken(secret: string, linkId: string): Promise<string> {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new LinkConfigError(`VIDEO_LINK_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(TOKEN_CONTEXT + linkId));
  return toBase64Url(new Uint8Array(mac));
}

/** SHA-256 of the token's UTF-8 text, as lower-case hex - the form stored in (and looked up in) report_video_links.token_hash. */
export async function hashTokenHex(token: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
}

/** PostgREST returns bytea as "\x<hex>"; accept either form and return bare lower-case hex (or null). */
export function normaliseHash(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(hex) ? hex.toLowerCase() : null;
}

/** The URL clients open. The token is the only secret in it. */
export function buildWatchUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('t', token);
  return url.toString();
}

// ---- issuing ---------------------------------------------------------------------------------------------------------------------

export interface LinkPlanRow {
  video_id: string;
  /** A reusable link of this video (not revoked, enough life left), or null when there is none. */
  link_id: string | null;
  /** That link's stored hash, as PostgREST returns it. */
  token_hash: string | null;
}

export interface NewLink {
  id: string;
  video_id: string;
  token_hash: string;
}

export interface IssuedLink {
  videoId: string;
  url: string;
  /** True when an existing link was reused rather than created. */
  reused: boolean;
}

export interface IssueDeps {
  secret: string;
  /** e.g. https://<project>.supabase.co/functions/v1/watch-report-video */
  watchBaseUrl: string;
  plan: () => Promise<LinkPlanRow[]>;
  /** Stores new links (id, video, token hash). Must throw if the database refuses. */
  register: (links: NewLink[]) => Promise<void>;
  newId: () => string;
}

/**
 * One URL per shareable video: reuses a video's existing link when this function can still derive its token and the hash matches the
 * stored one, otherwise creates a new link. New links are registered in ONE call, before any URL is returned - so a URL is never handed
 * out for a link the database does not know. Returns URLs in the plan's order.
 */
export async function issueLinks(deps: IssueDeps): Promise<IssuedLink[]> {
  const rows = await deps.plan();
  const out: (IssuedLink | null)[] = rows.map(() => null);
  const fresh: { index: number; link: NewLink; token: string }[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.link_id) {
      const token = await deriveToken(deps.secret, row.link_id);
      const stored = normaliseHash(row.token_hash);
      if (stored && stored === (await hashTokenHex(token))) {
        out[i] = { videoId: row.video_id, url: buildWatchUrl(deps.watchBaseUrl, token), reused: true };
        continue;
      }
    }
    const id = deps.newId();
    const token = await deriveToken(deps.secret, id);
    fresh.push({ index: i, link: { id, video_id: row.video_id, token_hash: await hashTokenHex(token) }, token });
  }

  if (fresh.length > 0) {
    await deps.register(fresh.map((f) => f.link));
    for (const f of fresh) out[f.index] = { videoId: f.link.video_id, url: buildWatchUrl(deps.watchBaseUrl, f.token), reused: false };
  }
  return out.filter((l): l is IssuedLink => l !== null);
}
