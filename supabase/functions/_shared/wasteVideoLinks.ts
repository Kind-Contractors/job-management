// Waste-report video links: how a link's token is made and reused - kept SEPARATE from the job-report links (./videoLinks.ts), which this
// file never changes. Only the generic pieces are shared (sha-256 of a token, the hash format, building the watch URL).
//
// A waste link's token is  base64url( HMAC-SHA256( WASTE_VIDEO_LINK_SECRET, "kc-waste-video-link-v1:" + link id ) ):
//   * a different secret AND a different prefix from job-report links, so the two systems can never produce each other's tokens;
//   * the database (waste_video_links) stores only sha256(token); the issuing function re-derives a link's token from its id to reuse it,
//     so the same video keeps the same URL across PDF downloads until it is close to expiry.
// Tokens and URLs containing them must never be logged; nothing in this file logs anything.
import { buildWatchUrl, hashTokenHex, LinkConfigError, normaliseHash, type IssuedLink, type LinkPlanRow, type NewLink } from './videoLinks.ts';

const WASTE_TOKEN_CONTEXT = 'kc-waste-video-link-v1:';
const MIN_SECRET_LENGTH = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The token for a waste link id. Deterministic for a given secret and id; unguessable without the secret. */
export async function deriveWasteToken(secret: string, linkId: string): Promise<string> {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new LinkConfigError(`WASTE_VIDEO_LINK_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(WASTE_TOKEN_CONTEXT + linkId));
  return toBase64Url(new Uint8Array(mac));
}

export interface WasteIssueDeps {
  secret: string;
  /** e.g. https://<project>.supabase.co/functions/v1/watch-waste-video */
  watchBaseUrl: string;
  plan: () => Promise<LinkPlanRow[]>;
  /** Stores new links (id, video, token hash). Must throw if the database refuses. */
  register: (links: NewLink[]) => Promise<void>;
  newId: () => string;
}

/**
 * One URL per video of the report: reuses a video's existing link when its token can be re-derived and matches the stored hash,
 * otherwise creates a new link. New links are registered in ONE call before any URL is returned. Returns URLs in the plan's order.
 */
export async function issueWasteLinks(deps: WasteIssueDeps): Promise<IssuedLink[]> {
  const rows = await deps.plan();
  const out: (IssuedLink | null)[] = rows.map(() => null);
  const fresh: { index: number; link: NewLink; token: string }[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.link_id) {
      const token = await deriveWasteToken(deps.secret, row.link_id);
      const stored = normaliseHash(row.token_hash);
      if (stored && stored === (await hashTokenHex(token))) {
        out[i] = { videoId: row.video_id, url: buildWatchUrl(deps.watchBaseUrl, token), reused: true };
        continue;
      }
    }
    const id = deps.newId();
    const token = await deriveWasteToken(deps.secret, id);
    fresh.push({ index: i, link: { id, video_id: row.video_id, token_hash: await hashTokenHex(token) }, token });
  }

  if (fresh.length > 0) {
    await deps.register(fresh.map((f) => f.link));
    for (const f of fresh) out[f.index] = { videoId: f.link.video_id, url: buildWatchUrl(deps.watchBaseUrl, f.token), reused: false };
  }
  return out.filter((l): l is IssuedLink => l !== null);
}
