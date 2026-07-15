/** Login BAL web reutilizable: launcher, SharedWorker, fallback y estados UX. */
import { BalError, BalGameClient, WebPostMessageTransport } from "nostr-game-protocol/bal";
import type { Event, EventTemplate } from "nostr-tools";
import {
  BalSharedConnection,
  hasSharedBalHint,
  type BalSharedConnectionOptions,
} from "./shared-client.js";
import { BalWindowHandshake } from "./window-handshake.js";

export type BalBrowserLoginConfig = {
  gameId: string;
  gameName: string;
  launcherName?: string;
  permissions: string[];
  shared: BalSharedConnectionOptions;
  launcherOriginStorageKey: string;
  launcherOriginParam?: string;
  balModeParam?: string;
  consentRequiredMessage?: string;
  focusRequestMessage?: string;
};

export interface BalBrowserSigner {
  readonly method: "nip46";
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
  nip04Encrypt(peer: string, plaintext: string): Promise<string>;
  nip04Decrypt(peer: string, ciphertext: string): Promise<string>;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  close(): Promise<void>;
}

type ResolvedConfig = BalBrowserLoginConfig & {
  launcherName: string;
  launcherOriginParam: string;
  balModeParam: string;
  consentRequiredMessage: string;
  focusRequestMessage: string;
};

let configuration: ResolvedConfig | null = null;

function config(): ResolvedConfig {
  if (!configuration) throw new Error("Creá la integración con createBalBrowserLogin(config)");
  return configuration;
}

let activeClient: BalGameClient<Window> | null = null;
let activeHandshake: BalWindowHandshake | null = null;
let activeShared: BalSharedConnection | null = null;
type RawBalLoginSession = Awaited<ReturnType<BalGameClient<Window>["login"]>>;
type BalLoginSession = Omit<RawBalLoginSession, "signer"> & {
  signer: RawBalLoginSession["signer"] | BalBrowserSigner;
};

export type BalSignerPhase =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "awaiting_approval"
  | "connected"
  | "signing"
  | "encrypting"
  | "decrypting"
  | "signed"
  | "disconnecting"
  | "disconnected"
  | "rejected"
  | "error";

export type BalSignerStatus = {
  phase: BalSignerPhase;
  detail: string | null;
};

const IDLE_STATUS: BalSignerStatus = { phase: "idle", detail: null };
let balStatus = IDLE_STATUS;
let hasLauncherContext = false;
let balOptedOut = false;
let transientTimer: ReturnType<typeof setTimeout> | null = null;
const statusListeners = new Set<(status: BalSignerStatus) => void>();

function setBalStatus(phase: BalSignerPhase, detail: string | null): void {
  if (transientTimer) {
    clearTimeout(transientTimer);
    transientTimer = null;
  }
  balStatus = { phase, detail };
  for (const listener of statusListeners) listener(balStatus);
}

function stableBalStatus(): BalSignerStatus {
  if (activeShared || activeClient) {
    return { phase: "connected", detail: `${config().launcherName} está firmando para ${config().gameName}` };
  }
  if (hasLauncherContext) return { phase: "disconnected", detail: "Sin una sesión de firma activa" };
  return IDLE_STATUS;
}

function returnToStableAfter(delayMs: number): void {
  if (transientTimer) clearTimeout(transientTimer);
  transientTimer = setTimeout(() => {
    transientTimer = null;
    const stable = stableBalStatus();
    balStatus = stable;
    for (const listener of statusListeners) listener(stable);
  }, delayMs);
}

function errorDetail(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function isRejected(error: unknown): boolean {
  return error instanceof BalError
    && (error.code === "USER_REJECTED" || error.code === "PERMISSION_DENIED");
}

export function getBalSignerStatus(): BalSignerStatus {
  return balStatus;
}

export function subscribeBalSignerStatus(
  listener: (status: BalSignerStatus) => void,
): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function validLauncherOrigin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.origin === raw && ["http:", "https:"].includes(parsed.protocol)
      ? parsed.origin
      : null;
  } catch { return null; }
}

/** Conserva por pestaña el origen del launcher, nunca credenciales BAL. */
function launcherOrigin(): string | null {
  const params = new URLSearchParams(location.search);
  if (params.get(config().balModeParam) === "off") {
    balOptedOut = true;
    forgetLauncherOrigin();
    return null;
  }
  if (balOptedOut) return null;
  const fromUrl = validLauncherOrigin(params.get(config().launcherOriginParam));
  if (fromUrl) {
    try { sessionStorage.setItem(config().launcherOriginStorageKey, fromUrl); }
    catch { /* storage bloqueado: BAL sigue hasta una recarga */ }
    return fromUrl;
  }
  try { return validLauncherOrigin(sessionStorage.getItem(config().launcherOriginStorageKey)); }
  catch { return null; }
}

function forgetLauncherOrigin(): void {
  try { sessionStorage.removeItem(config().launcherOriginStorageKey); }
  catch { /* noop */ }
}

function optOutOfBal(): void {
  balOptedOut = true;
  forgetLauncherOrigin();
  try {
    const url = new URL(location.href);
    url.searchParams.delete(config().launcherOriginParam);
    url.searchParams.set(config().balModeParam, "off");
    history.replaceState(null, "", url.toString());
  } catch { /* el estado en memoria igual evita otro intento */ }
}

export function hasBalLauncherContext(): boolean {
  const origin = launcherOrigin();
  if (balOptedOut) return false;
  const opener = window.opener;
  return Boolean(origin && opener && typeof opener.postMessage === "function")
    || hasSharedBalHint(config().shared.activeHintKey);
}

export async function tryBalLogin(
  onLauncherLogout: () => void,
  onConsentRequired?: () => void,
): Promise<BalBrowserSigner | null> {
  const originFromUrl = validLauncherOrigin(
    new URLSearchParams(location.search).get(config().launcherOriginParam),
  );
  const origin = launcherOrigin();
  if (balOptedOut) {
    hasLauncherContext = false;
    setBalStatus("idle", null);
    return null;
  }
  const opener = window.opener;
  const directLauncher = Boolean(origin && opener && typeof opener.postMessage === "function");
  let shared = activeShared ?? BalSharedConnection.create(config().shared);
  let endingShared = false;
  let session: BalLoginSession;
  let reconnecting: Promise<BalLoginSession> | null = null;

  hasLauncherContext = directLauncher || hasSharedBalHint(config().shared.activeHintKey);
  setBalStatus(
    originFromUrl ? "connecting" : hasLauncherContext ? "reconnecting" : "connecting",
    originFromUrl
      ? `Negociando una sesión con ${config().launcherName}`
      : hasLauncherContext
        ? "Buscando una sesión BAL compartida"
        : `Buscando un signer activo de ${config().launcherName}`,
  );

  const sessionFromState = async (
    state: Awaited<ReturnType<BalSharedConnection["attach"]>>,
  ): Promise<BalLoginSession | null> => {
    if (!state.active || !state.expiresAt) return null;
    const signer = shared!.signer();
    const pubkey = state.pubkey ?? await signer.getPublicKey();
    activeShared = shared;
    hasLauncherContext = true;
    return { signer, pubkey, expiresAt: state.expiresAt };
  };

  const sharedSession = async (): Promise<BalLoginSession | null> => {
    if (!shared) return null;
    try {
      let state = await shared.attach();
      if (!state.active && state.connecting && !state.connector) {
        state = await shared.waitUntilActive();
      }
      return sessionFromState(state);
    } catch {
      shared.release();
      if (activeShared === shared) activeShared = null;
      shared = null;
      return null;
    }
  };

  const connectFallback = async (): Promise<BalLoginSession> => {
    if (!origin || !opener || typeof opener.postMessage !== "function") {
      throw new BalError("NOT_AVAILABLE", `No hay una pestaña lanzada por ${config().launcherName}`);
    }
    const client = new BalGameClient({
      gameId: config().gameId,
      requestedPermissions: config().permissions,
      launcherOrigin: origin,
      launcherPeer: opener,
      transport: new WebPostMessageTransport(window),
      onLauncherLogout: () => {
        if (activeClient !== client) return;
        activeClient = null;
        forgetLauncherOrigin();
        hasLauncherContext = false;
        setBalStatus("disconnected", `${config().launcherName} cerró la sesión de firma`);
        returnToStableAfter(3500);
        onLauncherLogout();
      },
    });
    const previous = activeClient;
    activeClient = client;
    try {
      const next = await client.login();
      if (previous && previous !== client) void previous.logout("game_logout");
      return next;
    } catch (error) {
      if (activeClient === client) activeClient = previous;
      throw error;
    }
  };

  const connectThroughWorker = async (): Promise<BalLoginSession> => {
    if (!shared || !origin || !opener || typeof opener.postMessage !== "function") {
      throw new BalError("NOT_AVAILABLE", `No hay una pestaña lanzada por ${config().launcherName}`);
    }
    let state = await shared.claimConnector();
    const existing = await sessionFromState(state);
    if (existing) return existing;
    if (!state.connector) {
      state = await shared.waitUntilActive();
      const connected = await sessionFromState(state);
      if (connected) return connected;
      throw new BalError("NOT_AVAILABLE", "La otra pestaña no completó BAL");
    }

    const handleConsentRequired = (event: MessageEvent) => {
      if (event.source !== opener || event.origin !== origin) return;
      const message = event.data as { type?: unknown; gameId?: unknown } | null;
      if (
        message?.type === config().consentRequiredMessage
        && message.gameId === config().gameId
      ) {
        setBalStatus("awaiting_approval", `Esperando tu autorización en ${config().launcherName}`);
        onConsentRequired?.();
      }
    };
    window.addEventListener("message", handleConsentRequired);

    const handshake = new BalWindowHandshake({
      gameId: config().gameId,
      requestedPermissions: config().permissions,
      launcherOrigin: origin,
      launcherPeer: opener,
      onLauncherLogout: () => {
        if (activeHandshake !== handshake) return;
        activeHandshake = null;
        endingShared = true;
        shared?.endSession("launcher_logout");
        forgetLauncherOrigin();
        hasLauncherContext = false;
        setBalStatus("disconnected", `${config().launcherName} cerró la sesión de firma`);
        returnToStableAfter(3500);
        onLauncherLogout();
      },
    });
    activeHandshake?.closeControl();
    activeHandshake = handshake;
    let granted = false;
    try {
      const grant = await handshake.login(state.clientPubkey);
      granted = true;
      const opened = await shared.openSession(grant.bunkerUri, grant.expiresAt);
      const connected = await sessionFromState(opened);
      if (!connected) throw new BalError("NIP46_ERROR", "El worker no abrió la sesión BAL");
      return connected;
    } catch (error) {
      if (activeHandshake === handshake) activeHandshake = null;
      if (granted) await handshake.logout("game_logout");
      else handshake.closeControl();
      throw error;
    } finally {
      window.removeEventListener("message", handleConsentRequired);
    }
  };

  if (shared) {
    shared.onEnded(() => {
      if (endingShared || activeShared !== shared) return;
      activeShared = null;
      hasLauncherContext = directLauncher;
      setBalStatus("disconnected", "La sesión BAL compartida se cerró");
      returnToStableAfter(3500);
      onLauncherLogout();
    });
  }

  const connect = async (): Promise<BalLoginSession> => {
    const existing = await sharedSession();
    if (existing) {
      setBalStatus("connected", `Reutilizando la sesión BAL de otra pestaña de ${config().gameName}`);
      return existing;
    }
    const next = shared ? await connectThroughWorker() : await connectFallback();
    setBalStatus(
      "connected",
      shared
        ? `La sesión BAL vive en el worker compartido de ${config().gameName}`
        : `${config().launcherName} está firmando para ${config().gameName}`,
    );
    return next;
  };

  try {
    session = await connect();
    const withReconnect = async <T>(
      operation: (signer: BalLoginSession["signer"]) => Promise<T>,
    ): Promise<T> => {
      try {
        return await operation(session.signer);
      } catch (firstError) {
        // El worker es la conexión real y sobrevive a las pestañas. No se lo
        // reemplaza por un rechazo puntual de firma. El fallback v1 sí renegocia.
        if (activeShared) throw firstError;
        try {
          setBalStatus("reconnecting", `La sesión venció; reconectando con ${config().launcherName}`);
          reconnecting ??= connect().finally(() => { reconnecting = null; });
          session = await reconnecting;
          return await operation(session.signer);
        } catch (reconnectError) {
          console.warn("[BAL] no se pudo recuperar la sesión", { firstError, reconnectError });
          throw reconnectError;
        }
      }
    };

    return {
      method: "nip46",
      getPublicKey: () => withReconnect((signer) => signer.getPublicKey()),
      signEvent: (event: EventTemplate) => trackBalOperation(
        "signing",
        `Firmando evento kind ${event.kind}`,
        () => withReconnect((signer) => signer.signEvent(event)),
      ),
      nip04Encrypt: (peer, plaintext) => trackBalOperation(
        "encrypting",
        "Cifrando mensaje NIP-04",
        () => withReconnect((signer) => signer.nip04Encrypt!(peer, plaintext)),
      ),
      nip04Decrypt: (peer, ciphertext) => trackBalOperation(
        "decrypting",
        "Descifrando mensaje NIP-04",
        () => withReconnect((signer) => signer.nip04Decrypt!(peer, ciphertext)),
      ),
      nip44Encrypt: (peer, plaintext) => trackBalOperation(
        "encrypting",
        "Cifrando mensaje NIP-44",
        () => withReconnect((signer) => signer.nip44Encrypt!(peer, plaintext)),
      ),
      nip44Decrypt: (peer, ciphertext) => trackBalOperation(
        "decrypting",
        "Descifrando mensaje NIP-44",
        () => withReconnect((signer) => signer.nip44Decrypt!(peer, ciphertext)),
      ),
      close: () => session.signer.close?.() ?? Promise.resolve(),
    };
  } catch (error) {
    activeClient = null;
    if (activeShared === shared) activeShared = null;
    shared?.release();
    if (isRejected(error)) {
      optOutOfBal();
      hasLauncherContext = false;
      setBalStatus("idle", null);
      return null;
    }
    hasLauncherContext = directLauncher;
    if (directLauncher) setBalStatus("error", errorDetail(error, "No se pudo conectar el signer"));
    else setBalStatus("idle", null);
    return null;
  }
}

async function trackBalOperation<T>(
  phase: "signing" | "encrypting" | "decrypting",
  detail: string,
  operation: () => Promise<T>,
): Promise<T> {
  setBalStatus(phase, detail);
  try {
    const result = await operation();
    if (phase === "signing") {
      setBalStatus("signed", "Firma completada");
      returnToStableAfter(1400);
    } else {
      setBalStatus("connected", "Operación criptográfica completada");
      returnToStableAfter(700);
    }
    return result;
  } catch (error) {
    setBalStatus(
      isRejected(error) ? "rejected" : "error",
      errorDetail(error, isRejected(error) ? "La operación fue rechazada" : "Falló la operación del signer"),
    );
    throw error;
  }
}

export function requestBalLauncherFocus(): void {
  const origin = launcherOrigin();
  const opener = window.opener;
  if (!origin || !opener) return;
  try {
    opener.postMessage(
      { type: config().focusRequestMessage, gameId: config().gameId },
      origin,
    );
  }
  catch { /* fallback visual */ }
  try { opener.focus(); }
  catch { /* el navegador puede restringir el foco */ }
}

export async function logoutBal(options: { forgetLauncher?: boolean } = {}): Promise<void> {
  const client = activeClient;
  const handshake = activeHandshake;
  const shared = activeShared;
  if (client || shared) setBalStatus("disconnecting", "Cerrando esta pestaña del signer BAL");
  activeClient = null;
  activeHandshake = null;
  activeShared = null;
  // La conexión NIP-46 está en el worker. Soltar la pestaña original no la mata
  // mientras quede cualquier otra pestaña del juego conectada.
  shared?.release();
  handshake?.closeControl();
  await client?.logout("game_logout");
  if (options.forgetLauncher) {
    forgetLauncherOrigin();
    hasLauncherContext = false;
    setBalStatus("idle", null);
  } else if (hasLauncherContext) {
    setBalStatus("disconnected", "Esta pestaña dejó la sesión compartida");
  }
}

export type BalBrowserLogin = {
  getStatus(): BalSignerStatus;
  subscribeStatus(listener: (status: BalSignerStatus) => void): () => void;
  hasLauncherContext(): boolean;
  connect(
    onLauncherLogout: () => void,
    onConsentRequired?: () => void,
  ): Promise<BalBrowserSigner | null>;
  requestLauncherFocus(): void;
  logout(options?: { forgetLauncher?: boolean }): Promise<void>;
};

/**
 * Configura una integración BAL por aplicación. Cada juego carga una sola
 * identidad BAL, por eso el módulo mantiene un único coordinador en memoria.
 */
export function createBalBrowserLogin(input: BalBrowserLoginConfig): BalBrowserLogin {
  if (configuration) throw new Error("La integración BAL ya fue configurada en esta página");
  if (!input.gameId.trim() || !input.gameName.trim()) {
    throw new Error("BAL requiere gameId y gameName");
  }
  if (input.permissions.length === 0) throw new Error("BAL requiere permisos explícitos");
  configuration = {
    ...input,
    permissions: [...input.permissions],
    launcherName: input.launcherName ?? "Luna Negra",
    launcherOriginParam: input.launcherOriginParam ?? "lnOrigin",
    balModeParam: input.balModeParam ?? "lnBal",
    consentRequiredMessage: input.consentRequiredMessage ?? "luna-negra:bal-consent-required",
    focusRequestMessage: input.focusRequestMessage ?? "luna-negra:bal-focus-request",
  };
  return {
    getStatus: getBalSignerStatus,
    subscribeStatus: subscribeBalSignerStatus,
    hasLauncherContext: hasBalLauncherContext,
    connect: tryBalLogin,
    requestLauncherFocus: requestBalLauncherFocus,
    logout: logoutBal,
  };
}
