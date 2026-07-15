import { BalNip46Client } from "nostr-game-protocol/bal";
import type { EventTemplate } from "nostr-tools";
import {
  BalSharedWorkerHub,
  type BalSharedEngine,
} from "./worker-core.js";
import type { BalSharedMethod, BalSharedPort } from "./protocol.js";

type SharedWorkerConnectEvent = Event & { ports: MessagePort[] };
type SharedWorkerScope = typeof globalThis & {
  onconnect: ((event: SharedWorkerConnectEvent) => void) | null;
};

class Nip46WorkerEngine implements BalSharedEngine {
  private readonly client = new BalNip46Client();

  get clientPubkey(): string {
    return this.client.clientPubkey;
  }

  open(bunkerUri: string): Promise<void> {
    return this.client.open(bunkerUri);
  }

  call(method: BalSharedMethod, args: unknown[]): Promise<unknown> {
    if (method === "getPublicKey") return this.client.getPublicKey();
    if (method === "signEvent") return this.client.signEvent(args[0] as EventTemplate);
    return this.client[method](String(args[0] ?? ""), String(args[1] ?? ""));
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

const hub = new BalSharedWorkerHub(() => new Nip46WorkerEngine());
const scope = globalThis as SharedWorkerScope;

scope.onconnect = (event) => {
  const port = event.ports[0];
  if (port) hub.connect(port as BalSharedPort);
};

setInterval(() => hub.sweep(), 2_000);
