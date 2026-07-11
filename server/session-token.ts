/**
 * Token de sesión del lado del servidor (Node) — sin dependencias externas.
 *
 * Tras verificar UNA VEZ la firma del reto (ver verify-challenge.ts), emitís un
 * token HMAC. El cliente lo guarda y lo presenta al reconectar/recargar, así no
 * tiene que re-firmar en cada carga (la extensión/celu no siempre están listos).
 *
 * Es un JWT-lite: `base64url(payload).base64url(hmac)`. Sin libs (node:crypto).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secreto para firmar. Seteá AUTH_TOKEN_SECRET (env) para que los tokens SOBREVIVAN
 * a los reinicios/redeploys del server; si no, es aleatorio por proceso y cada
 * reinicio invalida todas las sesiones (el usuario re-firma una vez).
 *   openssl rand -hex 32
 */
const SECRET = process.env.AUTH_TOKEN_SECRET || randomBytes(32).toString("hex");
const TTL_SEC = 30 * 24 * 3600; // 30 días

interface Payload {
  p: string; // pubkey hex
  e: number; // expiración (epoch sec)
  [k: string]: unknown; // extras opcionales (displayName, etc.)
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("base64url");
}

/** Emite un token para una identidad ya verificada. `extra` = datos que quieras
 *  llevar (p. ej. displayName) sin re-consultar. */
export function issueSessionToken(
  pubkey: string,
  extra: Record<string, unknown> = {},
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const payload: Payload = { ...extra, p: pubkey, e: nowSec + TTL_SEC };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Verifica un token. Devuelve el payload (con `p` = pubkey) o null si inválido/vencido. */
export function verifySessionToken(
  token: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Payload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
  } catch {
    return null;
  }
  if (!payload.p || typeof payload.e !== "number" || payload.e < nowSec) return null;
  return payload;
}
