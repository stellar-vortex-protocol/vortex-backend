/**
 * Integration tests for the IntentsGateway replay path (#457).
 *
 * These tests inject a MemoryReplayStore directly into the gateway constructor
 * and drive handleReplay via the private method accessor pattern, so no
 * NestJS testing module is required.
 */
import { IntentsGateway } from '../intents.gateway';
import { MemoryReplayStore } from './memory-replay.store';
import { SequencedEvent } from './replay-store';
import { IntentsService } from '../intents.service';
import { SolversService } from '../../solvers/solvers.service';
import { IntentCapabilityIndex } from '../solver-intent-matcher';

jest.mock('../../common/logger', () => {
  // One shared spy object stands in for both the raw winston logger and every
  // component logger created with createLogger().
  const log: Record<string, jest.Mock> = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
  };
  log.child = jest.fn(() => log);
  return { logger: log, createLogger: jest.fn(() => log) };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(seq: number, type = 'intent_created'): SequencedEvent {
  return { seq, type };
}

function makeIntentsService(): Partial<IntentsService> {
  return {
    getByState: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue(null),
  };
}

function makeSolversService(): Partial<SolversService> {
  return {
    get: jest.fn().mockResolvedValue(null),
  };
}

function makeIntentIndex(): Partial<IntentCapabilityIndex> {
  return {
    rebuild: jest.fn().mockResolvedValue(undefined),
    addIntent: jest.fn(),
    removeIntent: jest.fn(),
    getEligibleFor: jest.fn().mockReturnValue([]),
  };
}

function createMockClient(readyState = 1 /* WebSocket.OPEN */) {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    readyState,
    send: jest.fn(),
    ping: jest.fn(),
    terminate: jest.fn(),
    close: jest.fn(),
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
    }),
    off: jest.fn(),
    _listeners: listeners,
  };
}

function createGateway(store: MemoryReplayStore): IntentsGateway {
  return new IntentsGateway(
    makeIntentsService() as IntentsService,
    makeSolversService() as SolversService,
    makeIntentIndex() as IntentCapabilityIndex,
    undefined, // metricsService
    store,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('IntentsGateway — replay path (MemoryReplayStore)', () => {
  let store: MemoryReplayStore;
  let gateway: IntentsGateway;

  beforeEach(() => {
    jest.useFakeTimers();
    store = new MemoryReplayStore({ maxCount: 100 });
    gateway = createGateway(store);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
  });

  it('delivers events in order for a valid replay request', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.append(makeEvent(i));
    }

    const client = createMockClient();
    // Register the client in the gateway
    await gateway.handleConnection(client as unknown as import('ws').WebSocket);
    client.send.mockClear();

    await (gateway as unknown as { handleReplay: (...args: unknown[]) => Promise<void> }).handleReplay(
      client,
      { type: 'replay', fromSeq: 2 },
    );

    const sent = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sent[0]).toMatchObject({ type: 'replay_start', fromSeq: 2, count: 3 });
    expect(sent[1]).toMatchObject({ seq: 3 });
    expect(sent[2]).toMatchObject({ seq: 4 });
    expect(sent[3]).toMatchObject({ seq: 5 });
    expect(sent[4]).toMatchObject({ type: 'replay_end', count: 3 });
  });

  it('sends replay_too_old when store has events from higher seq', async () => {
    // Populate a small store so seq 1–49 are evicted
    const smallStore = new MemoryReplayStore({ maxCount: 5 });
    for (let i = 100; i <= 110; i++) await smallStore.append(makeEvent(i));

    const gw = createGateway(smallStore);
    const client = createMockClient();
    await gw.handleConnection(client as unknown as import('ws').WebSocket);
    client.send.mockClear();

    await (gw as unknown as { handleReplay: (...args: unknown[]) => Promise<void> }).handleReplay(
      client,
      { type: 'replay', fromSeq: 50 },
    );

    gw.onModuleDestroy();

    const sent = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sent[0]).toMatchObject({ type: 'replay_too_old', fromSeq: 50 });
    expect(typeof sent[0].oldestAvailableSeq).toBe('number');
  });

  it('applies server-side chain filter during replay', async () => {
    const stellarEvent: SequencedEvent = {
      seq: 1,
      type: 'intent_created',
      intent: { srcChain: 'stellar', intentId: 'a' },
    };
    const ethEvent: SequencedEvent = {
      seq: 2,
      type: 'intent_created',
      intent: { srcChain: 'ethereum', intentId: 'b' },
    };
    await store.append(stellarEvent);
    await store.append(ethEvent);

    const client = createMockClient();
    await gateway.handleConnection(client as unknown as import('ws').WebSocket);

    // Subscribe to stellar only
    client._listeners.message(
      Buffer.from(JSON.stringify({ type: 'subscribe', chains: ['stellar'] })),
    );
    // Wait for the async message handler
    await Promise.resolve();

    client.send.mockClear();

    await (gateway as unknown as { handleReplay: (...args: unknown[]) => Promise<void> }).handleReplay(
      client,
      { type: 'replay', fromSeq: 0 },
    );

    const sent = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const events = sent.filter((m) => m.seq !== undefined);
    // Only stellar event should be delivered
    expect(events.some((e) => e.seq === 1)).toBe(true);
    expect(events.some((e) => e.seq === 2)).toBe(false);
  });

  it('handles empty store without crash', async () => {
    const client = createMockClient();
    await gateway.handleConnection(client as unknown as import('ws').WebSocket);
    client.send.mockClear();

    await expect(
      (gateway as unknown as { handleReplay: (...args: unknown[]) => Promise<void> }).handleReplay(
        client,
        { type: 'replay', fromSeq: 0 },
      ),
    ).resolves.not.toThrow();

    const sent = client.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sent[0]).toMatchObject({ type: 'replay_start', count: 0 });
    expect(sent[1]).toMatchObject({ type: 'replay_end', count: 0 });
  });

  it('ignores replay request with invalid fromSeq', async () => {
    const client = createMockClient();
    await gateway.handleConnection(client as unknown as import('ws').WebSocket);
    client.send.mockClear();

    await (gateway as unknown as { handleReplay: (...args: unknown[]) => Promise<void> }).handleReplay(
      client,
      { type: 'replay', fromSeq: -1 },
    );

    // No replay frames should have been sent
    expect(client.send).not.toHaveBeenCalled();
  });
});
