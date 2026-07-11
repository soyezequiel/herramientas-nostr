/**
 * Verificación del login por reto firmado (NIP-42, kind:22242) del lado del server.
 *
 * Flujo:
 *   1. El cliente pide login → el server genera `makeChallenge()` y lo manda,
 *      guardándolo atado a ESA conexión.
 *   2. El cliente firma un kind:22242 con el reto (signAuthChallenge del cliente) y
 *      lo devuelve.
 *   3. El server llama `verifyChallenge(event, challengeEsperado)` → si pasa, el
 *      `pubkey` es confiable. Emití entonces un token de sesión (session-token.ts).
 *
 * Solo depende de `nostr-tools`.
 */

import { randomBytes } from "node:crypto";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";

export const AUTH_KIND = 22242;

/** Ventana de frescura de la firma (segundos). */
const MAX_SKEW_SEC = 600;

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Reto aleatorio, uno por conexión/login. Guardalo atado a la conexión. */
export function makeChallenge(): string {
  return randomBytes(16).toString("hex");
}

export interface VerifiedIdentity {
  pubkey: string; // hex
  npub: string; // bech32
}

/**
 * Verifica el kind:22242 contra el reto emitido. Lanza AuthError si el kind, el
 * reto, la frescura o la FIRMA no cuadran. No confía en `content`: solo en la firma.
 */
export function verifyChallenge(
  event: Event,
  expectedChallenge: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): VerifiedIdentity {
  if (!event || typeof event !== "object") throw new AuthError("BAD_EVENT", "Evento ausente");
  if (event.kind !== AUTH_KIND) throw new AuthError("BAD_KIND", "Kind inesperado");
  const challenge = event.tags?.find((t) => t[0] === "challenge")?.[1];
  if (!challenge || challenge !== expectedChallenge)
    throw new AuthError("CHALLENGE_MISMATCH", "El challenge no coincide");
  if (!Number.isFinite(event.created_at) || Math.abs(nowSec - event.created_at) > MAX_SKEW_SEC)
    throw new AuthError("STALE_AUTH", "Firma de login vencida");
  if (!verifyEvent(event)) throw new AuthError("BAD_SIG", "Firma inválida");
  return { pubkey: event.pubkey, npub: npubEncode(event.pubkey) };
}
