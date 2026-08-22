# Agent Board event bus

Agent Board exposes a small same-process contract for independent Pi extensions. It has no Herdr or orchestrator dependency.

The Pi 0.84.2 event API is `pi.events.on(channel, handler)` and `pi.events.emit(channel, data)`. `on` returns an unsubscribe function. It does not provide reply callbacks. A request therefore includes a `requestId`, and Agent Board emits the response on a separate event.

## Events

`pi-agent-board:request-summary-v1`

Request payload:

```ts
{ schemaVersion: 1, requestId: string }
```

Agent Board ignores requests before session startup and after shutdown.

`pi-agent-board:summary-v1`

Response payload:

```ts
{
  schemaVersion: 1,
  requestId: string,
  snapshot: {
    schemaVersion: 1,
    productName: "Agent Board",
    preferredCommand: "/agentboard",
    health: "healthy" | "degraded" | "disabled" | "unsupported",
    pendingAsyncQuestionCount: number,
    pendingQuestions: Array<{
      questionId: string,
      revision: number,
      question: string,
      response: {
        kind: "single" | "multiple" | "text" | "single_or_text" | "multiple_or_text",
        options: Array<{ id: string, label: string, description?: string }>
      },
      recommendation?: string,
      recommendedOptionIds: string[],
      recommendedText?: string
    }>,
    significantActiveUpdates: Array<{
      id: string,
      kind: "working" | "warning" | "finding" | "blocked",
      title: string,
      updatedAt: string
    }>,
    unreadCount: number
  }
}
```

`significantActiveUpdates` contains at most 10 entries. `pendingQuestions` contains at most 10 actionable asynchronous questions. Each question contains at most 16 options. Question text and recommendation text are limited to 4000 characters. Option labels and descriptions are limited to 500 characters. These are the only fields needed to construct an existing revision-checked answer request. Synchronous `ask_user_question` and orchestrator questions are absent by construction. The snapshot contains no attachments, file contents, secrets, or full history.

`pi-agent-board:summary-changed-v1`

Change payload:

```ts
{ schemaVersion: 1, snapshot: /* the same snapshot shape */ }
```

Agent Board emits this event only after a durable state mutation has committed and only when the bounded snapshot changed. Listeners are removed on `session_shutdown`, including extension reload.

## Provider-owned actions v1

`pi-agent-board:action-request-v1` accepts bounded correlated requests. Every request has a caller-owned `requestId` and receives exactly one bounded response on `pi-agent-board:action-response-v1`.

```ts
{ schemaVersion: 1, requestId: string, action: 'open-ui' }
{ schemaVersion: 1, requestId: string, action: 'answer-question', questionId: string,
  expectedRevision: number, source: 'manual' | 'recommendation', value: AnswerValue }
```

`AnswerValue` is the existing validated union: `single`, `multiple`, `text`, `single_or_text`, or `multiple_or_text`. The provider calls the existing answer persistence and at-least-once delivery services. Revision, safety, durable ID, acknowledgement, and delivery rules are unchanged.

```ts
{ schemaVersion: 1, requestId: string, ok: true,
  value: { action: 'open-ui' | 'answer-question', answerId?: string } }
{ schemaVersion: 1, requestId: string, ok: false,
  error: { code: string, message: string, retryable: boolean } }
```

`open-ui` invokes the existing Agent Board UI handler in the current Pi session. `answer-question` requires one exact asynchronous question and its current revision. It cannot answer synchronous `ask_user_question` or orchestrator blocking questions. Invalid, stale, missing, or unavailable requests return errors without success. Listeners are removed on shutdown and reload. Responses and summary changes are emitted only after committed state; UI opening has no state mutation.

`ask_user_question` remains synchronous and blocking. Agent Board questions remain durable and asynchronous. This event bus does not change either behavior.
