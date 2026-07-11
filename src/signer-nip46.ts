/**
 * Conexión con firmantes remotos NIP-46 (Nostr Connect): Amber, Primal, nsec.app.
 *
 * Flujo por QR / "abrir en la app": usa `Nip46Client` (cliente propio con detección
 * NIP-44/NIP-04). Flujo `bunker://` pegado a mano: usa BunkerSigner de nostr-tools.
 */

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import {
  BunkerSigner,
  createNostrConnectURI,
  parseBunkerInput,
  type BunkerPointer,
} from "nostr-tools/nip46";
import { Nip46Client } from "./nip46-client.js";
import type { NostrSigner, StoredSigner } from "./signer.js";

/** Relays donde cliente y firmante se encuentran para el handshake. Grandes y
 *  abiertos, alcanzables por cualquier firmante genérico. Ajustá si querés. */
export const NIP46_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nsec.app"];

const QR_TIMEOUT_MS = 5 * 60_000;

/**
 * Permisos pre-solicitados en el URI nostrconnect://.
 * GOTCHA: pedí el genérico `sign_event` Y `sign_event:<kind>` por cada kind que vayas
 * a firmar. Firmantes con confianza "media" (Primal) solo pre-autorizan EXACTAMENTE
 * lo declarado, y sin el `sign_event:<kind>` se traban al firmar un kind puntual.
 * Poné acá los kinds que tu app firma (22242=login es el mínimo).
 */
export function nip46Perms(signKinds: number[] = [22242]): string[] {
  return [
    "get_public_key",
    "sign_event",
    ...signKinds.map((k) => `sign_event:${k}`),
    "nip04_encrypt",
    "nip04_decrypt",
    "nip44_encrypt",
    "nip44_decrypt",
  ];
}

function wrapBunker(signer: BunkerSigner): NostrSigner {
  return {
    method: "nip46",
    getPublicKey: () => signer.getPublicKey(),
    signEvent: (e) => signer.signEvent(e),
    nip04Encrypt: (p, t) => signer.nip04Encrypt(p, t),
    nip04Decrypt: (p, c) => signer.nip04Decrypt(p, c),
    nip44Encrypt: (p, t) => signer.nip44Encrypt(p, t),
    nip44Decrypt: (p, c) => signer.nip44Decrypt(p, c),
    close: () => signer.close(),
  };
}

function wrapClient(client: Nip46Client, ensureConnected: () => Promise<void> = async () => {}): NostrSigner {
  return {
    method: "nip46",
    getPublicKey: async () => (await ensureConnected(), client.getPublicKey()),
    signEvent: async (e) => (await ensureConnected(), client.signEvent(e)),
    nip04Encrypt: async (p, t) => (await ensureConnected(), client.nip04Encrypt(p, t)),
    nip04Decrypt: async (p, c) => (await ensureConnected(), client.nip04Decrypt(p, c)),
    nip44Encrypt: async (p, t) => (await ensureConnected(), client.nip44Encrypt(p, t)),
    nip44Decrypt: async (p, c) => (await ensureConnected(), client.nip44Decrypt(p, c)),
    close: () => client.close(),
  };
}

function storedNip46(clientSecretKey: Uint8Array, bp: BunkerPointer): StoredSigner {
  return {
    method: "nip46",
    clientNsec: nip19.nsecEncode(clientSecretKey),
    bunker: { relays: bp.relays, pubkey: bp.pubkey, secret: bp.secret },
  };
}

function storedFromClient(clientSecret: Uint8Array, client: Nip46Client): StoredSigner {
  return {
    method: "nip46",
    clientNsec: nip19.nsecEncode(clientSecret),
    bunker: {
      relays: client.relays,
      pubkey: client.bunkerPubkey,
      secret: client.secret,
      encryption: client.encryptionVersion,
    },
  };
}

/** Conecta con un `bunker://…` o un identificador NIP-05 (`usuario@dominio`). */
export async function connectBunker(
  input: string,
  onauth?: (url: string) => void,
): Promise<{ signer: NostrSigner; stored: StoredSigner }> {
  const bp = await parseBunkerInput(input.trim());
  if (!bp) throw new Error("No es un bunker:// ni un identificador NIP-05 válido");
  const clientSecretKey = generateSecretKey();
  const bunker = BunkerSigner.fromBunker(clientSecretKey, bp, { onauth });
  await bunker.connect();
  return { signer: wrapBunker(bunker), stored: storedNip46(clientSecretKey, bp) };
}

/**
 * Inicia el flujo Nostr Connect por QR: devuelve el URI `nostrconnect://` (para
 * mostrar como QR o link) y una promesa que resuelve cuando el firmante acepta.
 */
export function startNostrConnect(opts?: {
  appName?: string;
  signKinds?: number[];
  onauth?: (url: string) => void;
  signal?: AbortSignal;
  onDebug?: (line: string) => void;
}): { uri: string; established: Promise<{ signer: NostrSigner; stored: StoredSigner }> } {
  const clientSecret = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecret);
  const secret = crypto.randomUUID().replace(/-/g, "");
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: NIP46_RELAYS,
    secret,
    perms: nip46Perms(opts?.signKinds),
    name: opts?.appName ?? "Mi app",
    url: typeof window !== "undefined" ? window.location.origin : undefined,
  });
  const established = Nip46Client.fromURI({
    clientSecret,
    relays: NIP46_RELAYS,
    secret,
    timeoutMs: QR_TIMEOUT_MS,
    abortSignal: opts?.signal,
    onAuthUrl: opts?.onauth,
    onDiag: opts?.onDebug,
  })
    .then((client) => ({ signer: wrapClient(client), stored: storedFromClient(clientSecret, client) }))
    .catch((e: unknown) => {
      if (e instanceof Error && e.message === "__qr_timeout__") {
        throw new Error("El código expiró (5 min sin respuesta del firmante). Probá de nuevo.");
      }
      throw e;
    });
  return { uri, established };
}

/** Reconecta una sesión NIP-46 persistida (al restaurar la app). */
export async function restoreBunkerSigner(
  clientNsec: string,
  bunker: { relays: string[]; pubkey: string; secret: string | null; encryption?: "nip44" | "nip04" },
): Promise<NostrSigner> {
  const decoded = nip19.decode(clientNsec);
  if (decoded.type !== "nsec") throw new Error("clave de cliente inválida");

  if (bunker.encryption) {
    // Sesión del flujo QR (con cifrado detectado) → cliente propio dual.
    const client = Nip46Client.fromStored({
      clientSecret: decoded.data,
      bunkerPubkey: bunker.pubkey,
      relays: bunker.relays,
      secret: bunker.secret,
      encryption: bunker.encryption,
    });
    // `connect` best-effort: algunos firmantes tratan cada carga como sesión nueva.
    let connectPromise: Promise<void> | null = null;
    const ensureConnected = () => {
      if (!connectPromise) {
        connectPromise = Promise.race([
          client.connect().catch(() => {}),
          new Promise<void>((r) => setTimeout(r, 5000)),
        ]).then(() => {});
      }
      return connectPromise;
    };
    ensureConnected();
    return wrapClient(client, ensureConnected);
  }

  // Sesión legacy (bunker://) → BunkerSigner.
  const signer = BunkerSigner.fromBunker(decoded.data, bunker);
  await signer.connect();
  return wrapBunker(signer);
}
