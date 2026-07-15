import {
  BAL_PROTOCOL,
  BAL_VERSION,
  BalError,
  normalizeBalPermissions,
  parseBalError,
  parseBalLogout,
  parseBalSession,
  WebPostMessageTransport,
  type BalLogoutMessage,
  type BalReadyMessage,
} from "nostr-game-protocol/bal";

function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type BalWindowGrant = {
  bunkerUri: string;
  expiresAt: number;
};

/** Solo hace el postMessage inicial; el cliente NIP-46 vive en SharedWorker. */
export class BalWindowHandshake {
  private readonly requestId = randomId("request");
  private readonly nonce = randomId("nonce");
  private readonly transport = new WebPostMessageTransport(window);
  private unsubscribe: (() => void) | null = null;
  private connected = false;

  constructor(private readonly options: {
    gameId: string;
    requestedPermissions: string[];
    launcherOrigin: string;
    launcherPeer: Window;
    timeoutMs?: number;
    onLauncherLogout?: (reason: BalLogoutMessage["reason"]) => void;
  }) {}

  login(clientPubkey: string): Promise<BalWindowGrant> {
    const ready: BalReadyMessage = {
      protocol: BAL_PROTOCOL,
      version: BAL_VERSION,
      type: "BAL_READY",
      requestId: this.requestId,
      nonce: this.nonce,
      gameId: this.options.gameId,
      clientPubkey,
      requestedPermissions: normalizeBalPermissions(this.options.requestedPermissions),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.closeControl();
        reject(new BalError("NOT_AVAILABLE", "Luna Negra no respondió al handshake BAL"));
      }, this.options.timeoutMs ?? 2 * 60_000);

      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.closeControl();
        reject(error);
      };

      this.unsubscribe = this.transport.subscribe((envelope) => {
        if (envelope.peer !== this.options.launcherPeer || envelope.origin !== this.options.launcherOrigin) return;
        const candidate = envelope.data as { type?: unknown; requestId?: unknown; nonce?: unknown } | null;
        if (!candidate || candidate.requestId !== this.requestId || candidate.nonce !== this.nonce) return;
        if (candidate.type === "BAL_ERROR") {
          try {
            const error = parseBalError(candidate);
            rejectOnce(new BalError(error.code, error.message));
          } catch { /* no consume mensajes inválidos */ }
          return;
        }
        if (candidate.type === "BAL_LOGOUT") {
          try {
            const logout = parseBalLogout(candidate);
            if (!this.connected) rejectOnce(new BalError("NOT_AVAILABLE", "Luna Negra cerró la sesión BAL"));
            else this.options.onLauncherLogout?.(logout.reason);
          } catch { /* noop */ }
          return;
        }
        if (candidate.type !== "BAL_SESSION" || settled) return;
        try {
          const session = parseBalSession(candidate);
          settled = true;
          this.connected = true;
          clearTimeout(timer);
          resolve({ bunkerUri: session.bunkerUri, expiresAt: session.expiresAt });
        } catch (error) {
          rejectOnce(error);
        }
      });

      try {
        this.transport.send(this.options.launcherPeer, this.options.launcherOrigin, ready);
      } catch (error) {
        rejectOnce(new BalError("TRANSPORT_ERROR", "No se pudo enviar BAL_READY", error));
      }
    });
  }

  async logout(reason: BalLogoutMessage["reason"] = "game_logout"): Promise<void> {
    try {
      this.transport.send(this.options.launcherPeer, this.options.launcherOrigin, {
        protocol: BAL_PROTOCOL,
        version: BAL_VERSION,
        type: "BAL_LOGOUT",
        requestId: this.requestId,
        nonce: this.nonce,
        reason,
      });
    } catch { /* best effort */ }
    this.closeControl();
  }

  closeControl(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
