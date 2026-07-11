/**
 * Abstracción de firma Nostr, framework-agnóstica. La app habla con un
 * `NostrSigner` activo que puede ser:
 *  - "nip07": extensión del navegador (Alby, nos2x).
 *  - "nip46": firmante remoto Nostr Connect (Amber, Primal, nsec.app) por QR/bunker.
 *  - "local": clave en este navegador (generada o nsec importado).
 *
 * La sesión (método + datos para reconectar) se guarda en localStorage y se
 * restaura al reabrir la página, sin re-loguear. Diseñado para producción: trae
 * los arreglos de los gotchas (extensión asíncrona, cifrado dual NIP-46, etc.).
 *
 * Depende solo de `nostr-tools`.
 */

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip04,
  nip44,
  nip19,
  type Event,
} from "nostr-tools";

export type SignerMethod = "nip07" | "nip46" | "local";

export interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** Interfaz común a los tres métodos. Úsala en toda la app para firmar/cifrar. */
export interface NostrSigner {
  readonly method: SignerMethod;
  getPublicKey(): Promise<string>;
  signEvent(e: UnsignedEvent): Promise<Event>;
  /** NIP-44 (cifrado moderno; lo usa NIP-17 para DMs/retos cifrados). */
  nip44Encrypt?(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt?(peerPubkey: string, ciphertext: string): Promise<string>;
  /** NIP-04 (legacy; algunos firmantes/DMs lo usan). */
  nip04Encrypt?(peerPubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt?(peerPubkey: string, ciphertext: string): Promise<string>;
  /** Libera recursos (pool del firmante NIP-46). */
  close?(): Promise<void>;
}

// ─── Autenticación por reto firmado (NIP-42, kind:22242) ───────────────────
// Solo la necesitás si tenés un servidor autoritativo que quiere probar que el
// usuario controla la clave. Si tu app es 100% cliente, la identidad es la pubkey
// (getPublicKey) y no hace falta esto.

export const AUTH_KIND = 22242;

/** Firma un kind:22242 sobre el reto del server (prueba de posesión de la clave). */
export function signAuthChallenge(
  signer: NostrSigner,
  challenge: string,
  appName = "nostr-login",
): Promise<Event> {
  return signer.signEvent({
    kind: AUTH_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["challenge", challenge],
      ["relay", typeof location !== "undefined" ? location.origin : ""],
    ],
    content: appName,
  });
}

// ─── Persistencia de la sesión de signer (localStorage, JSON discriminado) ──

/** Cambiá el namespace si tenés varias apps en el mismo origen. */
export let STORAGE_KEY = "nostrtool.signer.v1";
export function setStorageKey(key: string): void {
  STORAGE_KEY = key;
}

export type StoredSigner = {
  /** Pubkey cacheada tras el primer login. Evita el RPC get_public_key (en NIP-46
   *  viaja por relays: segundos). La primera firma real igual valida la clave. */
  pubkey?: string;
} & (
  | { method: "nip07" }
  | { method: "local"; nsec: string }
  | {
      method: "nip46";
      clientNsec: string;
      bunker: {
        relays: string[];
        pubkey: string;
        secret: string | null;
        /** Cifrado detectado en el handshake (ver nip46-client.ts). */
        encryption?: "nip44" | "nip04";
      };
    }
);

function readStoredSigner(): StoredSigner | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSigner) : null;
  } catch {
    return null;
  }
}

function writeStoredSigner(stored: StoredSigner | null): void {
  if (typeof window === "undefined") return;
  try {
    if (stored) localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage bloqueado: la sesión no persiste */
  }
}

export function hasStoredSigner(): boolean {
  return readStoredSigner() !== null;
}

/** Cachea la pubkey en la sesión guardada (acelera el próximo restore de NIP-46). */
export function updateStoredPubkey(pubkey: string): void {
  const stored = readStoredSigner();
  if (!stored || stored.pubkey === pubkey) return;
  writeStoredSigner({ ...stored, pubkey });
}

// ─── Signer activo (singleton en memoria) ──────────────────────────────────

let active: NostrSigner | null = null;

export function getActiveSigner(): NostrSigner | null {
  return active;
}

export function setActiveSigner(signer: NostrSigner, stored: StoredSigner): void {
  active = signer;
  writeStoredSigner(stored);
}

export function clearActiveSigner(): void {
  const prev = active;
  active = null;
  writeStoredSigner(null);
  void prev?.close?.();
}

/**
 * Restaura el signer guardado al arrancar la app. Devuelve null si no había sesión
 * o falló. NO borra la sesión si falla transitoriamente (p. ej. la extensión aún
 * no inyectó window.nostr) — así se reintenta al recargar.
 */
export async function restoreSigner(): Promise<NostrSigner | null> {
  if (active) return active;
  const stored = readStoredSigner();
  if (!stored) return null;
  try {
    if (stored.method === "nip07") {
      // GOTCHA: las extensiones inyectan window.nostr de forma ASÍNCRONA tras cargar
      // la página. En un reload todavía no está en el primer tick; si te rendís al
      // instante, la sesión "se cierra" en cada recarga. Esperá.
      if (!(await waitForNip07(3000))) return null;
      active = createNip07Signer();
    } else if (stored.method === "local") {
      active = importNsec(stored.nsec);
    } else {
      const { restoreBunkerSigner } = await import("./signer-nip46.js");
      const signer = await restoreBunkerSigner(stored.clientNsec, stored.bunker);
      // Con pubkey cacheada evitamos el get_public_key por relays (lento). Solo
      // NIP-46: en NIP-07 el usuario puede haber cambiado de cuenta en la extensión.
      active = stored.pubkey ? { ...signer, getPublicKey: async () => stored.pubkey! } : signer;
    }
    return active;
  } catch {
    return null;
  }
}

// ─── NIP-07 (extensión) ─────────────────────────────────────────────────────

interface FullNip07 {
  getPublicKey(): Promise<string>;
  signEvent(e: UnsignedEvent): Promise<Event>;
  nip04?: { encrypt(pk: string, pt: string): Promise<string>; decrypt(pk: string, ct: string): Promise<string> };
  nip44?: { encrypt(pk: string, pt: string): Promise<string>; decrypt(pk: string, ct: string): Promise<string> };
}

function win(): FullNip07 | undefined {
  return typeof window !== "undefined"
    ? ((window as unknown as { nostr?: FullNip07 }).nostr ?? undefined)
    : undefined;
}

/** Espera a que la extensión inyecte window.nostr (lo hacen async tras load). */
export async function waitForNip07(timeoutMs = 3000): Promise<FullNip07 | null> {
  const started = Date.now();
  while (!win() && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return win() ?? null;
}

export function createNip07Signer(): NostrSigner {
  const nostr = () => {
    const n = win();
    if (!n) throw new Error("Necesitás una extensión Nostr (Alby/nos2x)");
    return n;
  };
  return {
    method: "nip07",
    getPublicKey: () => nostr().getPublicKey(),
    signEvent: (e) => nostr().signEvent(e),
    nip04Encrypt: (peer, pt) => {
      const n = nostr();
      if (!n.nip04) throw new Error("Tu extensión no soporta NIP-04");
      return n.nip04.encrypt(peer, pt);
    },
    nip04Decrypt: (peer, ct) => {
      const n = nostr();
      if (!n.nip04) throw new Error("Tu extensión no soporta NIP-04");
      return n.nip04.decrypt(peer, ct);
    },
    nip44Encrypt: (peer, pt) => {
      const n = nostr();
      if (!n.nip44) throw new Error("Tu extensión no soporta NIP-44");
      return n.nip44.encrypt(peer, pt);
    },
    nip44Decrypt: (peer, ct) => {
      const n = nostr();
      if (!n.nip44) throw new Error("Tu extensión no soporta NIP-44");
      return n.nip44.decrypt(peer, ct);
    },
  };
}

// ─── Clave local (generada o nsec importado; guardada plana en localStorage) ─

export function createLocalSigner(secretKey: Uint8Array): NostrSigner {
  const pubkey = getPublicKey(secretKey);
  return {
    method: "local",
    getPublicKey: async () => pubkey,
    signEvent: async (e) => finalizeEvent(e, secretKey),
    nip04Encrypt: async (peer, pt) => nip04.encrypt(secretKey, peer, pt),
    nip04Decrypt: async (peer, ct) => nip04.decrypt(secretKey, peer, ct),
    nip44Encrypt: async (peer, pt) => nip44.encrypt(pt, nip44.getConversationKey(secretKey, peer)),
    nip44Decrypt: async (peer, ct) => nip44.decrypt(ct, nip44.getConversationKey(secretKey, peer)),
  };
}

export function generateLocalSigner(): { signer: NostrSigner; nsec: string } {
  const sk = generateSecretKey();
  return { signer: createLocalSigner(sk), nsec: nip19.nsecEncode(sk) };
}

/** Valida y decodifica un nsec; lanza con mensaje claro si no lo es. */
export function importNsec(nsec: string): NostrSigner {
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(nsec.trim());
  } catch {
    throw new Error("Eso no parece un nsec válido");
  }
  if (decoded.type !== "nsec") throw new Error("Eso no es una clave privada (nsec)");
  return createLocalSigner(decoded.data);
}
