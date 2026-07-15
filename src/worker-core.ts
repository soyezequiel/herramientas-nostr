import {
  isBalSharedMethod,
  type BalSharedError,
  type BalSharedMethod,
  type BalSharedPort,
  type BalSharedState,
  type BalSharedTabMessage,
  type BalSharedWorkerMessage,
} from "./protocol.js";

export interface BalSharedEngine {
  readonly clientPubkey: string;
  open(bunkerUri: string): Promise<void>;
  call(method: BalSharedMethod, args: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

type Connection = {
  port: BalSharedPort;
  tabId: string | null;
  lastSeen: number;
};

const CONNECTOR_STALE_MS = 90_000;

function serializeError(error: unknown): BalSharedError {
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown } | null;
  return {
    name: typeof candidate?.name === "string" ? candidate.name : "Error",
    message: typeof candidate?.message === "string" ? candidate.message : "Falló la sesión BAL compartida",
    ...(typeof candidate?.code === "string" ? { code: candidate.code } : {}),
  };
}

/** Mantiene el cliente NIP-46 dentro del worker, nunca dentro de una pestaña. */
export class BalSharedWorkerHub {
  private readonly connections = new Set<Connection>();
  private readonly tabs = new Map<string, Connection>();
  private engine: BalSharedEngine;
  private connectorTabId: string | null = null;
  private active = false;
  private expiresAt: number | null = null;
  private pubkey: string | null = null;

  constructor(
    private readonly createEngine: () => BalSharedEngine,
    private readonly now: () => number = Date.now,
  ) {
    this.engine = createEngine();
  }

  connect(port: BalSharedPort): void {
    const connection: Connection = { port, tabId: null, lastSeen: this.now() };
    this.connections.add(connection);
    port.addEventListener("message", (event) => { void this.handle(connection, event.data); });
    port.start();
  }

  sweep(): void {
    if (this.active && this.expiresAt !== null && this.expiresAt <= this.now()) {
      void this.endSession("expired");
      return;
    }
    if (!this.active && this.connectorTabId) {
      const connector = this.tabs.get(this.connectorTabId);
      if (!connector || this.now() - connector.lastSeen > CONNECTOR_STALE_MS) {
        this.connectorTabId = null;
        this.broadcastState();
      }
    }
  }

  private async handle(connection: Connection, raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Partial<BalSharedTabMessage>;
    if (message.type === "HELLO") {
      if (typeof message.tabId !== "string" || typeof message.requestId !== "string") return;
      this.bind(connection, message.tabId);
      this.replyState(connection, message.requestId);
      return;
    }
    if (!connection.tabId || message.tabId !== connection.tabId) return;
    connection.lastSeen = this.now();

    if (message.type === "HEARTBEAT") return;
    if (message.type === "CLAIM_CONNECTOR") {
      if (typeof message.requestId !== "string") return;
      this.sweep();
      if (!this.active && !this.connectorTabId) this.connectorTabId = connection.tabId;
      this.replyState(connection, message.requestId);
      return;
    }
    if (message.type === "OPEN_SESSION") {
      if (
        typeof message.requestId !== "string"
        || typeof message.bunkerUri !== "string"
        || typeof message.expiresAt !== "number"
      ) return;
      await this.openSession(connection, message.requestId, message.bunkerUri, message.expiresAt);
      return;
    }
    if (message.type === "RPC") {
      if (
        typeof message.callId !== "string"
        || !isBalSharedMethod(message.method)
        || !Array.isArray(message.args)
      ) return;
      await this.runRpc(connection, message.callId, message.method, message.args);
      return;
    }
    if (message.type === "END_SESSION") {
      if (connection.tabId === this.connectorTabId) {
        await this.endSession(typeof message.reason === "string" ? message.reason : "launcher_logout");
      }
      return;
    }
    if (message.type === "RELEASE") {
      const wasConnector = connection.tabId === this.connectorTabId;
      this.unbind(connection);
      if (wasConnector) this.connectorTabId = null;
      if (this.tabs.size === 0) await this.endSession("last_tab_closed");
      else this.broadcastState();
    }
  }

  private async openSession(
    connection: Connection,
    requestId: string,
    bunkerUri: string,
    expiresAt: number,
  ): Promise<void> {
    if (connection.tabId !== this.connectorTabId || this.active) {
      this.send(connection, {
        type: "CONTROL_ERROR",
        requestId,
        error: { name: "BalError", code: "PERMISSION_DENIED", message: "Esta pestaña no puede entregar la sesión BAL" },
      });
      return;
    }
    try {
      await this.engine.open(bunkerUri);
      this.pubkey = String(await this.engine.call("getPublicKey", []));
      this.expiresAt = expiresAt;
      this.active = true;
      this.replyState(connection, requestId);
      this.broadcastState();
    } catch (error) {
      await this.replaceEngine();
      this.connectorTabId = null;
      this.send(connection, { type: "CONTROL_ERROR", requestId, error: serializeError(error) });
      this.broadcastState();
    }
  }

  private async runRpc(
    connection: Connection,
    callId: string,
    method: BalSharedMethod,
    args: unknown[],
  ): Promise<void> {
    this.sweep();
    if (!this.active) {
      this.send(connection, {
        type: "RPC_RESULT",
        callId,
        error: { name: "BalError", code: "NOT_AVAILABLE", message: "No hay una sesión BAL compartida activa" },
      });
      return;
    }
    try {
      const result = await this.engine.call(method, args);
      this.send(connection, { type: "RPC_RESULT", callId, result });
    } catch (error) {
      this.send(connection, { type: "RPC_RESULT", callId, error: serializeError(error) });
    }
  }

  private bind(connection: Connection, tabId: string): void {
    if (connection.tabId && connection.tabId !== tabId) this.tabs.delete(connection.tabId);
    const previous = this.tabs.get(tabId);
    if (previous && previous !== connection) this.connections.delete(previous);
    connection.tabId = tabId;
    connection.lastSeen = this.now();
    this.tabs.set(tabId, connection);
  }

  private unbind(connection: Connection): void {
    this.connections.delete(connection);
    if (connection.tabId && this.tabs.get(connection.tabId) === connection) {
      this.tabs.delete(connection.tabId);
    }
  }

  private stateFor(connection: Connection): BalSharedState {
    return {
      active: this.active,
      connecting: !this.active && this.connectorTabId !== null,
      connector: connection.tabId === this.connectorTabId,
      expiresAt: this.expiresAt,
      clientPubkey: this.engine.clientPubkey,
      pubkey: this.pubkey,
    };
  }

  private replyState(connection: Connection, requestId: string): void {
    this.send(connection, { type: "STATE", requestId, ...this.stateFor(connection) });
  }

  private broadcastState(): void {
    for (const connection of this.connections) {
      this.send(connection, { type: "STATE_CHANGED", ...this.stateFor(connection) });
    }
  }

  private async endSession(reason: string): Promise<void> {
    const hadSession = this.active || this.connectorTabId !== null;
    this.active = false;
    this.connectorTabId = null;
    this.expiresAt = null;
    this.pubkey = null;
    await this.replaceEngine();
    if (!hadSession) return;
    for (const connection of this.connections) {
      this.send(connection, { type: "SESSION_ENDED", reason });
    }
  }

  private async replaceEngine(): Promise<void> {
    const previous = this.engine;
    this.engine = this.createEngine();
    try { await previous.close(); } catch { /* el estado local igual se descarta */ }
  }

  private send(connection: Connection, message: BalSharedWorkerMessage): void {
    try { connection.port.postMessage(message); }
    catch { this.unbind(connection); }
  }
}
