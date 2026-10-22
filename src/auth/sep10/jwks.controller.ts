import { Controller, Get, Header } from '@nestjs/common';
import { createPublicKey, KeyObject } from 'crypto';
import { ed25519PublicKeyFor } from '../../common/jwt';

export interface EdDsaJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  use: 'sig';
  alg: 'EdDSA';
  kid: string;
}

export interface JwksResponse {
  keys: EdDsaJwk[];
}

/**
 * Derives a stable, deterministic key id from the raw Ed25519 public key
 * (base64url `x` coordinate). Uses SHA-256 over the raw public key bytes and
 * truncates to a short, URL-safe identifier (RFC 7638-style thumbprint).
 */
function deriveKid(publicKey: KeyObject): string {
  const raw = publicKey.export({ format: 'der', type: 'spki' });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('crypto') as typeof import('crypto');
  return createHash('sha256').update(raw).digest('base64url').slice(0, 16);
}

/**
 * Builds the EdDSA JWK for the current SEP-10 signing key, or `null` when
 * `SEP10_JWT_SIGNING_KEY` is unset (SEP-10 auth disabled).
 */
function buildJwk(): EdDsaJwk | null {
  const publicKey = ed25519PublicKeyFor();
  if (!publicKey) {
    return null;
  }

  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };

  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: jwk.x,
    use: 'sig',
    alg: 'EdDSA',
    kid: deriveKid(publicKey),
  };
}

// Cache the derived JWK for the process lifetime: `SEP10_JWT_SIGNING_KEY` is
// only read at boot, so recomputing per-request is wasted work.
let cachedJwk: EdDsaJwk | null | undefined;

function getCachedJwk(): EdDsaJwk | null {
  if (cachedJwk === undefined) {
    cachedJwk = buildJwk();
  }
  return cachedJwk;
}

/**
 * Public JWKS endpoint publishing the SEP-10 EdDSA session-token public key
 * (RFC 7517 / RFC 8037). No auth guard: third parties must be able to fetch
 * this to independently verify session JWTs.
 */
@Controller('.well-known')
export class JwksController {
  @Get('jwks.json')
  @Header('Cache-Control', 'public, max-age=300')
  getJwks(): JwksResponse {
    const jwk = getCachedJwk();
    return { keys: jwk ? [jwk] : [] };
  }
}