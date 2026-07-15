import { BalError } from "nostr-game-protocol/bal";
import type { Event, EventTemplate } from "nostr-tools";
import {
  type BalSharedError,
  type BalSharedMethod,
  type BalSharedPort,
  type BalSharedState,
  type BalSharedWorkerMessage,
} from "./protocol.js";

const REQUEST_TIMEOUT_MS = 35_000;

export type BalSharedConnectionOptions = {
  createWorker(): SharedWorker;
  activeHintKey: string;
};

export interface BalSharedSigner {
  readonly method: "nip46";
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
  nip04Encrypt(peer: string, plaintext: string): Promise<string>;
  nip04Decrypt(peer: string, ciphertext: string): Promise<string>;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  close(): Promise<void>;
}

type Pending<T> = {
  resolve(value: T): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

function randomId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function deserializeError(error: BalSharedError): Error {
  if (error.code) return new BalError(error.code as ConstructorParameters<typeof BalError>[0], error.message);
  const result = new Error(error.message);
  result.name = error.name;
  return result;
}

export function hasSharedBalHint(activeHintKey: string): boolean {
  try {
    const parsed = JSON.parse(localStorage.getItem(activeHintKey) ?? "null") as { expiresAt?: unknown } | null;
    if (typeof parsed?.expiresAt === "number" && parsed.expiresAt > Date.now()) return true;
    localStorage.removeItem(activeHintKey);
  } catch { /* storage bloqueado o marcador inválido */ }
  return false;
}

function writeSharedBalHint(activeHintKey: string, expiresAt: number | null): void {
  try {
    if (expiresAt && expiresAt > Date.now()) {
      localStorage.setItem(activeHintKey, JSON.stringify({ expiresAt }));
    } else {
      localStorage.removeItem(activeHintKey);
    }
  } catch { /* el worker sigue siendo la fuente de verdad */ }
}

export class BalSharedConnection {
  readonly tabId = randomId("tab");
  private readonly port: BalSharedPort;
  private readonly controlPending = new Map<string, Pending<BalSharedState>>();
  private readonly rpcPending = new Map<string, Pending<unknown>>();
  private readonly endedListeners = new Set<(reason: string) => void>();
  private readonly stateListeners = new Set<(state: BalSharedState) => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private state: BalSharedState | null = null;

  static create(options: BalSharedConnectionOptions): BalSharedConnection | null {
    if (typeof SharedWorker !== "function") return null;
    try {
      const worker = options.createWorker();
      return new BalSharedConnection(worker.port as BalSharedPort, options.activeHintKey);
    } catch {
      return null;
    }
  }

  constructor(port: BalSharedPort, private readonly activeHintKey: string) {
    this.port = port;
    port.addEventListener("message", (event) => this.handle(event.data));
    port.start();
    this.heartbeat = setInterval(() => {
      this.send({ type: "HEARTBEAT", tabId: this.tabId });
    }, 2_000);
  }

  attach(): Promise<BalSharedState> {
    return this.control("HELLO");
  }

  claimConnector(): Promise<BalSharedState> {
    return this.control("CLAIM_CONNECTOR");
  }

  openSession(bunkerUri: string, expiresAt: number): Promise<BalSharedState> {
    return this.control("OPEN_SESSION", { bunkerUri, expiresAt });
  }

  waitUntilActive(timeoutMs = 35_000): Promise<BalSharedState> {
    if (this.state?.active) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stateListeners.delete(listener);
        reject(new BalError("NOT_AVAILABLE", "La otra pestaña no terminó de conectar BAL"));
      }, timeoutMs);
      const listener = (state: BalSharedState) => {
        if (!state.active) return;
        clearTimeout(timer);
        this.stateListeners.delete(listener);
        resolve(state);
      };
      this.stateListeners.add(listener);
    });
  }

  signer(): BalSharedSigner {
    return {
      method: "nip46",
      getPublicKey: () => this.rpc<string>("getPublicKey", []),
      signEvent: (event: EventTemplate) => this.rpc("signEvent", [event]),
      nip04Encrypt: (peer, plaintext) => this.rpc("nip04Encrypt", [peer, plaintext]),
      nip04Decrypt: (peer, ciphertext) => this.rpc("nip04Decrypt", [peer, ciphertext]),
      nip44Encrypt: (peer, plaintext) => this.rpc("nip44Encrypt", [peer, plaintext]),
      nip44Decrypt: (peer, ciphertext) => this.rpc("nip44Decrypt", [peer, ciphertext]),
      close: async () => {},
    };
  }

  onEnded(listener: (reason: string) => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  endSession(reason: string): void {
    this.send({ type: "END_SESSION", tabId: this.tabId, reason });
  }

  release(): void {
    if (this.closed) return;
    this.send({ type: "RELEASE", tabId: this.tabId });
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const pending of [...this.controlPending.values(), ...this.rpcPending.values()]) {
      clearTimeout(pending.timer);
      pending.reject(new BalError("NOT_AVAILABLE", "La pestaña se desconectó del BAL compartido"));
    }
    this.controlPending.clear();
    this.rpcPending.clear();
    this.port.close?.();
  }

  private control(
    type: "HELLO" | "CLAIM_CONNECTOR" | "OPEN_SESSION",
    session?: { bunkerUri: string; expiresAt: number },
  ): Promise<BalSharedState> {
    const requestId = randomId("control");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controlPending.delete(requestId);
        reject(new BalError("NOT_AVAILABLE", "El worker BAL compartido no respondió"));
      }, REQUEST_TIMEOUT_MS);
      this.controlPending.set(requestId, { resolve, reject, timer });
      if (type === "OPEN_SESSION") {
        this.send({ type, requestId, tabId: this.tabId, ...session! });
      } else {
        this.send({ type, requestId, tabId: this.tabId });
      }
    });
  }

  private rpc<T>(method: BalSharedMethod, args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new BalError("NOT_AVAILABLE", "BAL compartido está cerrado"));
    const callId = randomId("rpc");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcPending.delete(callId);
        reject(new BalError("NIP46_ERROR", `Timeout BAL compartido en ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.rpcPending.set(callId, { resolve: (value) => resolve(value as T), reject, timer });
      this.send({ type: "RPC", callId, tabId: this.tabId, method, args });
    });
  }

  private handle(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const message = raw as BalSharedWorkerMessage;
    if (message.type === "STATE") {
      const pending = this.controlPending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.controlPending.delete(message.requestId);
      const state = this.readState(message);
      pending.resolve(state);
      return;
    }
    if (message.type === "CONTROL_ERROR") {
      const pending = this.controlPending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.controlPending.delete(message.requestId);
      pending.reject(deserializeError(message.error));
      return;
    }
    if (message.type === "STATE_CHANGED") {
      this.readState(message);
      return;
    }
    if (message.type === "RPC_RESULT") {
      const pending = this.rpcPending.get(message.callId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.rpcPending.delete(message.callId);
      if (message.error) pending.reject(deserializeError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.type === "SESSION_ENDED") {
      if (this.state) {
        this.state = { ...this.state, active: false, connecting: false, connector: false, expiresAt: null, pubkey: null };
      }
      writeSharedBalHint(this.activeHintKey, null);
      for (const listener of this.endedListeners) listener(message.reason);
    }
  }

  private readState(state: BalSharedState): BalSharedState {
    this.state = {
      active: state.active,
      connecting: state.connecting,
      connector: state.connector,
      expiresAt: state.expiresAt,
      clientPubkey: state.clientPubkey,
      pubkey: state.pubkey,
    };
    writeSharedBalHint(this.activeHintKey, this.state.active ? this.state.expiresAt : null);
    for (const listener of this.stateListeners) listener(this.state);
    return this.state;
  }

  private send(message: Parameters<BalSharedPort["postMessage"]>[0]): void {
    if (this.closed) return;
    this.port.postMessage(message);
  }
}
