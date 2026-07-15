export type BalSharedMethod =
  | "getPublicKey"
  | "signEvent"
  | "nip04Encrypt"
  | "nip04Decrypt"
  | "nip44Encrypt"
  | "nip44Decrypt";

export type BalSharedError = {
  name: string;
  message: string;
  code?: string;
};

export type BalSharedState = {
  active: boolean;
  connecting: boolean;
  connector: boolean;
  expiresAt: number | null;
  clientPubkey: string;
  pubkey: string | null;
};

export type BalSharedTabMessage =
  | { type: "HELLO"; requestId: string; tabId: string }
  | { type: "HEARTBEAT"; tabId: string }
  | { type: "CLAIM_CONNECTOR"; requestId: string; tabId: string }
  | { type: "OPEN_SESSION"; requestId: string; tabId: string; bunkerUri: string; expiresAt: number }
  | { type: "RPC"; callId: string; tabId: string; method: BalSharedMethod; args: unknown[] }
  | { type: "END_SESSION"; tabId: string; reason: string }
  | { type: "RELEASE"; tabId: string };

export type BalSharedWorkerMessage =
  | ({ type: "STATE"; requestId: string } & BalSharedState)
  | ({ type: "STATE_CHANGED" } & BalSharedState)
  | { type: "CONTROL_ERROR"; requestId: string; error: BalSharedError }
  | { type: "RPC_RESULT"; callId: string; result?: unknown; error?: BalSharedError }
  | { type: "SESSION_ENDED"; reason: string };

export interface BalSharedPort {
  postMessage(message: BalSharedTabMessage | BalSharedWorkerMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  start(): void;
  close?(): void;
}

export function isBalSharedMethod(value: unknown): value is BalSharedMethod {
  return value === "getPublicKey"
    || value === "signEvent"
    || value === "nip04Encrypt"
    || value === "nip04Decrypt"
    || value === "nip44Encrypt"
    || value === "nip44Decrypt";
}
