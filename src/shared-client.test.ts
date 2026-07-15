import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BalSharedWorkerHub,
  type BalSharedEngine,
} from "./worker-core.js";
import type { BalSharedMethod, BalSharedPort } from "./protocol.js";

class FakePort implements BalSharedPort {
  peer: FakePort | null = null;
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  postMessage(message: Parameters<BalSharedPort["postMessage"]>[0]): void {
    const peer = this.peer;
    if (!peer) return;
    queueMicrotask(() => {
      for (const listener of peer.listeners) listener({ data: message } as MessageEvent<unknown>);
    });
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  start(): void {}

  close(): void {
    this.peer = null;
  }
}

function portPair(): [FakePort, FakePort] {
  const page = new FakePort();
  const worker = new FakePort();
  page.peer = worker;
  worker.peer = page;
  return [page, worker];
}

let engineSerial = 0;
const engines: FakeEngine[] = [];

class FakeEngine implements BalSharedEngine {
  readonly clientPubkey = (++engineSerial).toString(16).padStart(64, "0");
  readonly close = vi.fn(async () => {});
  readonly signEvent = vi.fn(async (event: Record<string, unknown>) => ({
    ...event,
    id: "signed",
    pubkey: "a".repeat(64),
    sig: "c".repeat(128),
  }));
  private opened = false;

  async open(bunkerUri: string): Promise<void> {
    if (!bunkerUri.startsWith("bunker://")) throw new Error("URI inválida");
    this.opened = true;
  }

  async call(method: BalSharedMethod, args: unknown[]): Promise<unknown> {
    if (!this.opened) throw new Error("engine cerrado");
    if (method === "getPublicKey") return "a".repeat(64);
    if (method === "signEvent") return this.signEvent(args[0] as Record<string, unknown>);
    return String(args[1] ?? "");
  }
}

const hub = new BalSharedWorkerHub(() => {
  const engine = new FakeEngine();
  engines.push(engine);
  return engine;
});
const connectionOptions = {
  createWorker: () => new FakeSharedWorker() as unknown as SharedWorker,
  activeHintKey: "test-game.bal.active",
};

class FakeSharedWorker {
  readonly port: FakePort;

  constructor() {
    const [pagePort, workerPort] = portPair();
    this.port = pagePort;
    hub.connect(workerPort);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("SharedWorker", FakeSharedWorker);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    removeItem: vi.fn((key: string) => storage.delete(key)),
  });
});

describe("BAL SharedWorker broker", () => {
  it("mantiene el signer cuando se cierra la pestaña que hizo el handshake", async () => {
    const { BalSharedConnection, hasSharedBalHint } = await import("./shared-client.js");
    const launcherTab = BalSharedConnection.create(connectionOptions)!;
    const otherTab = BalSharedConnection.create(connectionOptions)!;
    const expiresAt = Date.now() + 60_000;

    expect((await launcherTab.attach()).active).toBe(false);
    const claim = await launcherTab.claimConnector();
    expect(claim).toMatchObject({ active: false, connecting: true, connector: true });
    const opened = await launcherTab.openSession("bunker://session", expiresAt);
    expect(opened).toMatchObject({ active: true, connector: true, expiresAt });
    expect(hasSharedBalHint(connectionOptions.activeHintKey)).toBe(true);

    expect(await otherTab.attach()).toMatchObject({ active: true, connector: false, expiresAt });
    launcherTab.release();
    await Promise.resolve();

    const signed = await otherTab.signer().signEvent({
      kind: 1,
      created_at: 1,
      tags: [],
      content: "la pestaña original ya se cerró",
    });
    expect(signed.id).toBe("signed");
    expect(engines.at(-1)?.close).not.toHaveBeenCalled();

    const activeEngine = engines.at(-1)!;
    otherTab.release();
    await vi.waitFor(() => expect(activeEngine.close).toHaveBeenCalledOnce());
  });

  it("cierra el worker para todos cuando Luna revoca la sesión", async () => {
    const { BalSharedConnection } = await import("./shared-client.js");
    const launcherTab = BalSharedConnection.create(connectionOptions)!;
    const otherTab = BalSharedConnection.create(connectionOptions)!;
    await launcherTab.attach();
    await launcherTab.claimConnector();
    await launcherTab.openSession("bunker://session", Date.now() + 60_000);
    await otherTab.attach();
    const ended = vi.fn();
    otherTab.onEnded(ended);

    launcherTab.endSession("launcher_logout");
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce());

    launcherTab.release();
    otherTab.release();
  });
});
