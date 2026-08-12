export const SYNTHETIC_PRIVATE_MARKERS = [
  'SYNTHETIC_SECRET_DO_NOT_LOG',
  'Synthetic question content must stay private.',
  'Synthetic answer content must stay private.',
  '/workspace/signal-fixture/private-path',
  'SYNTHETIC_STACK_MARKER',
] as const;

export class SyntheticLogCapture {
  readonly records: string[] = [];

  constructor(readonly forbiddenMarkers: readonly string[] = SYNTHETIC_PRIVATE_MARKERS) {}

  record(value: unknown): void {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const marker of this.forbiddenMarkers) {
      if (text.includes(marker)) throw new Error(`Synthetic private marker was logged: ${marker}`);
    }
    this.records.push(text);
  }
}
