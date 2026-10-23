import { Controller, Get, Header, Inject, Optional } from "@nestjs/common";
import { ed25519JwkFor, type Ed25519Jwk } from "../../common/jwt";
import { SEP10_KEYS, sep10Keys, type Sep10KeyMaterial } from "./sep10-keys";

export type EdDsaJwk = Ed25519Jwk;

export interface JwksResponse {
  keys: EdDsaJwk[];
}

/**
 * Public JWKS endpoint publishing the SEP-10 EdDSA session-token public key
 * (RFC 7517 / RFC 8037). No auth guard: third parties must be able to fetch
 * this to independently verify session JWTs.
 */
@Controller(".well-known")
export class JwksController {
  constructor(@Optional() @Inject(SEP10_KEYS) private readonly keys?: Sep10KeyMaterial) {}

  @Get("jwks.json")
  @Header("Cache-Control", "public, max-age=300")
  getJwks(): JwksResponse {
    const material =
      this.keys ??
      sep10Keys(process.env.STELLAR_SIGNER_SECRET_KEY ?? "", process.env.SEP10_JWT_SIGNING_KEY ?? "");
    const jwk = ed25519JwkFor(material.jwtPublicKey);
    return { keys: jwk ? [jwk] : [] };
  }
}
