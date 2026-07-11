/**
 * Store del token de sesión en el cliente (localStorage).
 *
 * El token lo emite TU SERVIDOR tras un login firmado (ver server/session-token.ts).
 * Sirve para reconectar/recargar SIN volver a firmar — como la cookie de sesión de
 * una app web tradicional. Solo lo necesitás si tenés un servidor autoritativo que
 * exige probar la identidad; una app 100% cliente no lo usa.
 */

const TOKEN_KEY = "nostrtool.session.v1";

export function readSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeSessionToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage bloqueado */
  }
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}
