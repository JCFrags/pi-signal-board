import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { createEmptyBoardState } from '../../src/domain/reducer.js';
import {
  AGENT_BOARD_VIEW_REQUEST_EVENT,
  AGENT_BOARD_VIEW_RESPONSE_EVENT,
  registerAgentBoardEventBus,
} from '../../src/integration/event-bus.js';
import type { SignalBoardRuntime } from '../../src/runtime/types.js';

type Handler = (data: unknown) => void;

function makeRuntime(): SignalBoardRuntime {
  return {
    generation: 1,
    identity: { persistence: 'ephemeral', token: 'provider-test' },
    treeRevision: 0,
    context: {} as SignalBoardRuntime['context'],
    queue: {} as SignalBoardRuntime['queue'],
    compatibility: {} as SignalBoardRuntime['compatibility'],
    config: { config: DEFAULT_CONFIG } as SignalBoardRuntime['config'],
    diagnostics: {} as SignalBoardRuntime['diagnostics'],
    state: createEmptyBoardState(),
    status: 'healthy',
    timer: undefined,
    disposed: false,
    disposeCount: 0,
    notifications: new Set(),
    effectiveCommand: {
      baseName: 'signals',
      invocationName: 'agentboard',
      invocation: '/signalboard',
      discovered: false,
      collision: false,
      ambiguous: false,
    },
  };
}

describe('Signals provider contract v2', () => {
  it('returns the native four-view bounded snapshot with correlated request ID', () => {
    const handlers = new Map<string, Set<Handler>>();
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const bus = {
      on(channel: string, handler: Handler) {
        const set = handlers.get(channel) ?? new Set<Handler>();
        set.add(handler);
        handlers.set(channel, set);
        return () => set.delete(handler);
      },
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
        for (const handler of handlers.get(channel) ?? []) handler(data);
      },
    };
    const registration = registerAgentBoardEventBus(bus, makeRuntime, {
      openUi: async () => ({ ok: true }),
      answerQuestion: async () => ({ ok: true, answerId: 'ans_test' }),
      now: () => '2026-08-21T00:00:00.000Z',
    });
    registration.start();
    bus.emit(AGENT_BOARD_VIEW_REQUEST_EVENT, { schemaVersion: 2, requestId: 'view-1' });
    const response = emitted.find((entry) => entry.channel === AGENT_BOARD_VIEW_RESPONSE_EVENT)
      ?.data as {
      schemaVersion: number;
      requestId: string;
      snapshot: { view: { tabs: Record<string, unknown> }; transport: { bounded: boolean } };
    };
    expect(response.schemaVersion).toBe(2);
    expect(response.requestId).toBe('view-1');
    expect(Object.keys(response.snapshot.view.tabs)).toEqual([
      'inbox',
      'updates',
      'decisions',
      'history',
    ]);
    expect(response.snapshot.transport.bounded).toBe(true);
    registration.shutdown();
  });
});
