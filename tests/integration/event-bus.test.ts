import { describe, expect, it } from 'vitest';
import { createEmptyBoardState } from '../../src/domain/reducer.js';
import {
  AGENT_BOARD_ACTION_REQUEST_EVENT,
  AGENT_BOARD_ACTION_RESPONSE_EVENT,
  AGENT_BOARD_REQUEST_SUMMARY_EVENT,
  AGENT_BOARD_SUMMARY_CHANGED_EVENT,
  AGENT_BOARD_SUMMARY_EVENT,
  registerAgentBoardEventBus,
} from '../../src/integration/event-bus.js';
import type { SignalBoardRuntime } from '../../src/runtime/types.js';

type Handler = (data: unknown) => void;

function eventBus() {
  const handlers = new Map<string, Set<Handler>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    emitted,
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
    request(data: unknown) {
      for (const handler of handlers.get(AGENT_BOARD_REQUEST_SUMMARY_EVENT) ?? []) handler(data);
    },
  };
}

function runtime(): SignalBoardRuntime {
  return {
    generation: 1,
    identity: { persistence: 'ephemeral', token: 'test' },
    treeRevision: 0,
    context: {} as SignalBoardRuntime['context'],
    queue: {} as SignalBoardRuntime['queue'],
    compatibility: {} as SignalBoardRuntime['compatibility'],
    config: {} as SignalBoardRuntime['config'],
    diagnostics: {} as SignalBoardRuntime['diagnostics'],
    state: createEmptyBoardState(),
    status: 'healthy',
    timer: undefined,
    disposed: false,
    disposeCount: 0,
    notifications: new Set(),
    effectiveCommand: {
      baseName: 'agent-board',
      invocationName: 'agentboard',
      invocation: '/agentboard',
      discovered: true,
      collision: false,
      ambiguous: false,
    },
  };
}

describe('Agent Board event-bus contract', () => {
  it('responds with a versioned bounded snapshot only after startup', () => {
    const bus = eventBus();
    const current = runtime();
    const registration = registerAgentBoardEventBus(bus, () => current);

    bus.request({ schemaVersion: 1, requestId: 'before-start' });
    expect(bus.emitted).toHaveLength(0);

    registration.start();
    bus.request({ schemaVersion: 1, requestId: 'deck-1' });
    expect(bus.emitted).toHaveLength(1);
    expect(bus.emitted[0]?.channel).toBe(AGENT_BOARD_SUMMARY_EVENT);
    expect(bus.emitted[0]?.data).toEqual({
      schemaVersion: 1,
      requestId: 'deck-1',
      snapshot: {
        schemaVersion: 1,
        productName: 'Agent Board',
        preferredCommand: '/agent-board',
        health: 'healthy',
        pendingAsyncQuestionCount: 0,
        pendingQuestions: [],
        significantActiveUpdates: [],
        unreadCount: 0,
      },
    });
    expect(JSON.stringify(bus.emitted[0]?.data)).not.toContain('history');
  });

  it('routes only provider-owned actions and returns correlated bounded responses', async () => {
    const bus = eventBus();
    const registration = registerAgentBoardEventBus(bus, runtime, {
      openUi: async () => ({ ok: true }),
      answerQuestion: async (request) => ({ ok: true, answerId: `answer-for-${request.questionId}` }),
    });
    registration.start();
    bus.emit(AGENT_BOARD_ACTION_REQUEST_EVENT, { schemaVersion: 1, requestId: 'open-1', action: 'open-ui' });
    bus.emit(AGENT_BOARD_ACTION_REQUEST_EVENT, {
      schemaVersion: 1, requestId: 'answer-1', action: 'answer-question', questionId: 'question:1',
      expectedRevision: 1, source: 'manual', value: { kind: 'text', text: 'yes' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const responses = bus.emitted.filter((entry) => entry.channel === AGENT_BOARD_ACTION_RESPONSE_EVENT);
    expect(responses).toHaveLength(2);
    expect(responses[0]?.data).toMatchObject({ schemaVersion: 1, requestId: 'open-1', ok: true });
    expect(responses[1]?.data).toMatchObject({ schemaVersion: 1, requestId: 'answer-1', ok: true, value: { answerId: 'answer-for-question:1' } });
    registration.shutdown();
    bus.emit(AGENT_BOARD_ACTION_REQUEST_EVENT, { schemaVersion: 1, requestId: 'after', action: 'open-ui' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bus.emitted.filter((entry) => entry.channel === AGENT_BOARD_ACTION_RESPONSE_EVENT)).toHaveLength(2);
  });

  it('notifies only when a committed snapshot changes and removes listeners on shutdown', () => {
    const bus = eventBus();
    let current = runtime();
    const registration = registerAgentBoardEventBus(bus, () => current);
    registration.start();

    registration.notifyCommittedChange();
    registration.notifyCommittedChange();
    expect(bus.emitted.filter((entry) => entry.channel === AGENT_BOARD_SUMMARY_CHANGED_EVENT)).toHaveLength(1);

    current = { ...current, status: 'degraded' };
    registration.notifyCommittedChange();
    expect(bus.emitted.filter((entry) => entry.channel === AGENT_BOARD_SUMMARY_CHANGED_EVENT)).toHaveLength(2);

    registration.shutdown();
    bus.request({ schemaVersion: 1, requestId: 'after-shutdown' });
    expect(bus.emitted.filter((entry) => entry.channel === AGENT_BOARD_SUMMARY_EVENT)).toHaveLength(0);
  });
});
