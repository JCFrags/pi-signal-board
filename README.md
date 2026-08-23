# Signals

Signals keeps significant coding-agent updates visible outside the chat transcript and provides a structured asynchronous question inbox.

## Requirements

- Node.js 22.19.0 or newer.
- Pi coding agent `>=0.84.1 <0.85.0`.
- An interactive terminal for the full board and answer UI.

## Install

```bash
pi install npm:pi-signal-board
```

Install for one trusted project instead of globally:

```bash
pi install -l npm:pi-signal-board
```

Try without retaining an install:

```bash
pi -e npm:pi-signal-board
```

## Use

- Open Signals with `/signals` or `Ctrl+Shift+B`.
- Run `/signals summary` for a plain text summary.
- Run `/signals doctor` for redacted compatibility and replay diagnostics.
- `/signalboard` remains a compatibility alias.
- Agents receive three Signals tools: `signal_board_update`, `signal_board_question`, and `signal_board_ack`.

Answers are delivered at least once. The agent deduplicates by immutable answer ID and acknowledges whether the answer was applied.

## Questions

`ask_user_question` is synchronous and blocking. It waits for the user's answer in the current interaction. `signal_board_question` creates a durable asynchronous Signals question, so independent work can continue. Both tools remain because their behavior differs.

## Ownership

Signals owns only its board events and asynchronous question inbox. The orchestrator remains the task authority. A todo product remains a local checklist. Signals does not replace either one.

## Data and privacy

Board events are stored locally in the current Pi session branch. Logical reset hides prior board state but does not securely erase Pi session JSONL. The package has no backend, telemetry, or network feature. Attachments are inert metadata and are never opened automatically.

## Configuration

Global configuration: `~/.pi/agent/pi-signal-board.json`.

Trusted project configuration: `<project>/.pi/pi-signal-board.json` (using Pi's configured project directory name). Project configuration is not read unless Pi reports the project trusted.

See the package documentation for the complete version-1 schema and defaults. Separate integrations can use the exported read-only Signals summary API. The exported `getAgentBoardSummary` name remains a compatibility namespace for existing consumers.

## Update and remove

```bash
pi update npm:pi-signal-board
pi remove npm:pi-signal-board
```

## Security

Pi extensions run with the user's process permissions. Review package source before installing. Signals intentionally performs no shell execution, process spawning, network requests, arbitrary project reads, or automatic attachment activation. See `SECURITY.md` for reporting.
