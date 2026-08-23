# Signals provider contract v2

Signals exposes a versioned same-process provider contract for a separate Pi side panel. The provider remains the authority for revisions, validation, safety checks, persistence, delivery, acknowledgement, and mutations. The contract does not import or depend on Herdr. The primary standalone command is `/signals`. `/signalboard` is the compatibility alias. The provider does not register `/agent-board`.

## View channels

- Request: `pi-agent-board:view-request-v2`
- Response: `pi-agent-board:view-response-v2`
- Change: `pi-agent-board:view-changed-v2`

A request is `{ schemaVersion: 2, requestId, openedAt?, selections? }`. The response and change payload are `{ schemaVersion: 2, requestId?, snapshot }`. `requestId` is required on responses and absent on change events.

The snapshot is:

```ts
{
  schemaVersion: 2,
  productName: "Signals",
  preferredCommand: string,
  health: "healthy" | "degraded" | "disabled" | "unsupported",
  openedAt: string,
  view: BoardViewModel,
  transport: { maxRowsPerView: 200, bounded: true },
  fallback: {
    openUiAction: "open-ui",
    unsupported: ["native terminal key navigation", "native confirmation/editor dialogs"]
  }
}
```

`BoardViewModel` is the native model from `src/ui/board/model.ts`. It contains the four native views: `inbox`, `updates`, `decisions`, and `history`; row lists; selected IDs; selected details; empty states; catch-up changes since last viewed; tab counts; and UI metadata. Details preserve update kind, stage, measurable progress, attachments, question response specifications, all recommendation fields, delivery state, answer, acknowledgement, and decision data. Each view has at most 200 rows and matching detail entries. `count` and `visibleCount` show whether transport truncation occurred. History also reports its configured truncation fields.

The provider uses the same selectors and native view builder. `selections` selects the requested entity in each view. If a request omits `openedAt`, the provider timestamp is used.

## Actions

Requests use `pi-agent-board:action-request-v1` for compatibility or schema version 2 for the provider contract. Every request has a caller `requestId`; every request receives one response on `pi-agent-board:action-response-v1`.

Version 2 actions are:

- `open-ui`
- `answer-question` with `questionId`, `expectedRevision`, and `value`
- `accept-recommendation` with `questionId` and `expectedRevision`
- `dismiss-question` with `questionId` and `expectedRevision`
- `retry-delivery` with `questionId`, `answerId`, and `expectedRevision`
- `archive-update` with `updateId` and `expectedRevision`
- `acknowledge-answer` with `answerId`, `outcome`, `summary`, optional `resultingUpdateIds`, and optional `attachments`

`value` is the existing union for all response kinds: `text`, `single`, `multiple`, `single_or_text`, and `multiple_or_text`. The provider validates it against the current question and expected revision. Recommendation acceptance is recomputed by the provider and cannot submit a caller-provided replacement. Mutations use existing services and their durable command boundaries. Stale, invalid, unavailable, or unsafe requests return the existing bounded error code/message/retryable shape and do not report success.

`acknowledge-answer` supports every acknowledgement outcome: `applied`, `partially_applied`, `cannot_apply`, `duplicate`, and `superseded`. It is an agent-side workflow action, not a replacement for the normal `signal_board_ack` tool.

## Compatibility and unsupported native behavior

The existing v1 summary request/response, summary change event, v1 answer action, `/signals` command, `/signalboard` compatibility command, and native TUI remain unchanged. `open-ui` is the fallback for behavior that is inherently terminal or host-dialog specific: key navigation, help display, confirmation dialogs, text editor dialogs, and custom multiple-answer widgets. The side panel can represent all persisted board data and all provider mutations without that fallback.

Synchronous `ask_user_question` and orchestrator questions are not Signals entities and remain outside this contract.
