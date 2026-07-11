/**
 * Ejemplo mínimo del flujo de login + sesión persistente, framework-agnóstico.
 * Copiá y adaptá a tu UI (vanilla, React, etc.). Los puntos marcados con ⚠️ son
 * los que evitan los problemas típicos — no los saltees.
 *
 * Asume un backend por WebSocket con estos mensajes (adaptá a tu transporte):
 *   cliente → server: {t:'auth_challenge'} | {t:'auth_nostr', event} | {t:'auth_token', token}
 *   server → cliente: {t:'challenge', challenge} | {t:'authed', identity, token?} | {t:'error', code}
 *
 * Si tu app es 100% cliente (sin server autoritativo), NO necesitás token ni
 * challenge: la identidad es `await signer.getPublicKey()` y listo.
 */

import {
  type NostrSigner,
  restoreSigner,
  setActiveSigner,
  clearActiveSigner,
  createNip07Signer,
  waitForNip07,
  generateLocalSigner,
  importNsec,
  signAuthChallenge,
  readSessionToken,
  writeSessionToken,
  clearSessionToken,
  startNostrConnect,
  connectBunker,
} from "../src/index.js";

declare const net: {
  connect(): void;
  send(msg: unknown): void;
  on(event: string, fn: (m: any) => void): void;
};

let signer: NostrSigner | null = null;

// ── Arranque: reconstituir la sesión ───────────────────────────────────────
export async function start(): Promise<void> {
  // ⚠️ 1) Con token, autenticá DE INMEDIATO sin depender del firmador. La extensión
  //    puede tardar o estar bloqueada; si esperás su getPublicKey, te colgás en
  //    "Conectando…". El firmador se restaura de fondo (para features que firmen).
  const token = readSessionToken();
  if (token) {
    net.connect();
    net.send({ t: "auth_token", token });
    restoreSigner().then((s) => {
      signer = s; // disponible para features; puede tardar/fallar sin cerrar sesión
    });
    return;
  }
  // Sin token pero con sesión de firmador guardada (raro): restaurar y firmar.
  const restored = await restoreSigner();
  if (restored) return void beginNostr(restored);
  // Nada guardado → mostrá tu pantalla de login (extensión / QR / bunker / clave local).
}

// ── Métodos de login (uno por botón) ────────────────────────────────────────
export async function loginExtension(): Promise<void> {
  const provider = await waitForNip07(1500); // ⚠️ 2) esperá: la extensión inyecta async
  if (!provider) return alert("No se detectó extensión. Probá Alby o nos2x.");
  const s = createNip07Signer();
  setActiveSigner(s, { method: "nip07" });
  await beginNostr(s);
}

export function loginQR(showQr: (uri: string) => void): void {
  // ⚠️ 3) startNostrConnect usa el cliente dual NIP-44/NIP-04 (funciona con Amber/Primal).
  const { uri, established } = startNostrConnect({ appName: "Mi app", signKinds: [22242] });
  showQr(uri); // renderá el QR y/o un link "abrir en la app"
  established.then(({ signer: s, stored }) => {
    setActiveSigner(s, stored);
    void beginNostr(s);
  });
}

export async function loginBunker(input: string): Promise<void> {
  const { signer: s, stored } = await connectBunker(input);
  setActiveSigner(s, stored);
  await beginNostr(s);
}

export function loginLocal(nsec?: string): void {
  const { signer: s, nsec: generated } =
    nsec && nsec.trim() ? { signer: importNsec(nsec), nsec: nsec.trim() } : generateLocalSigner();
  setActiveSigner(s, { method: "local", nsec: generated });
  if (!nsec) alert("Guardá tu clave (nsec): es tu identidad y no se recupera.");
  void beginNostr(s);
}

// ── Handshake con el server ─────────────────────────────────────────────────
async function beginNostr(s: NostrSigner): Promise<void> {
  signer = s;
  net.connect();
  const token = readSessionToken();
  if (token) net.send({ t: "auth_token", token }); // reusa sesión, no re-firma
  else net.send({ t: "auth_challenge" }); // primer login: firma el reto
}

// ── Wiring de mensajes del server (una sola vez) ────────────────────────────
export function wire(): void {
  net.on("challenge", async (m: { challenge: string }) => {
    if (!signer) return;
    const event = await signAuthChallenge(signer, m.challenge, "Mi app");
    net.send({ t: "auth_nostr", event });
  });
  net.on("authed", (m: { token?: string }) => {
    if (m.token) writeSessionToken(m.token); // guardá/rotá el token
    // mostrá la app…
  });
  net.on("error", (m: { code: string }) => {
    // ⚠️ 4) token vencido → descartalo y volvé a firmar (fallback automático).
    if (m.code === "BAD_TOKEN") {
      clearSessionToken();
      if (signer) net.send({ t: "auth_challenge" });
    }
  });
}

export function logout(): void {
  clearActiveSigner();
  clearSessionToken();
  signer = null;
  location.reload();
}
