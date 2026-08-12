import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';

import type { EffectiveConfig } from '../config/types.js';
import { STATUS_ID, WIDGET_ID } from '../constants.js';
import type { BoardState } from '../domain/types.js';
import type { DiagnosticSafeCategory, Diagnostics } from '../services/diagnostics.js';
import { renderStatusText } from './status/index.js';
import { renderWidgetLines } from './widget/index.js';

export interface UiAdapterRefresh {
  readonly state: BoardState;
  readonly config: EffectiveConfig;
  readonly currentTime: string;
  readonly completedWindowCutoff: string;
  readonly effectiveCommand: string;
}

export interface SignalBoardUiAdapter {
  refresh(input: UiAdapterRefresh): void;
  dispose(): void;
}

/**
 * Own the two namespaced Pi UI surfaces for one session runtime.
 * Every host call is isolated so a missing or failed surface stays recoverable.
 */
export function createSignalBoardUiAdapter(
  context: ExtensionContext,
  diagnostics: Diagnostics,
): SignalBoardUiAdapter {
  return new RuntimeUiAdapter(context, diagnostics);
}

class RuntimeUiAdapter implements SignalBoardUiAdapter {
  readonly #context: ExtensionContext;
  readonly #diagnostics: Diagnostics;
  #disposed = false;
  #diagnosticTime = '1970-01-01T00:00:00.000Z';

  constructor(context: ExtensionContext, diagnostics: Diagnostics) {
    this.#context = context;
    this.#diagnostics = diagnostics;
  }

  refresh(input: UiAdapterRefresh): void {
    if (this.#disposed || !this.hasUi()) return;
    this.#diagnosticTime = normalizeTimestamp(input.currentTime);

    if (!input.config.enabled) {
      this.clearBoth();
      return;
    }

    this.refreshWidget(input);
    this.refreshStatus(input);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.hasUi()) this.clearBoth();
  }

  private hasUi(): boolean {
    try {
      return this.#context.hasUI;
    } catch {
      this.recordUiUnavailable('ui_unsupported');
      return false;
    }
  }

  private refreshWidget(input: UiAdapterRefresh): void {
    if (!input.config.widget.enabled) {
      this.setWidget(undefined);
      return;
    }

    const render = (width: number): readonly string[] =>
      renderWidgetLines(input.state, input.config, {
        completedWindowCutoff: input.completedWindowCutoff,
        currentTime: input.currentTime,
        effectiveCommand: input.effectiveCommand,
        width,
      });

    let probe: readonly string[];
    try {
      probe = render(80);
    } catch {
      this.recordUiUnavailable('ui_failure');
      this.setWidget(undefined);
      return;
    }

    if (probe.length === 0) {
      this.setWidget(undefined);
      return;
    }

    this.setWidget(
      (): Component => ({
        render: (width) => {
          try {
            return [...render(width)];
          } catch {
            this.recordUiUnavailable('ui_failure');
            return [];
          }
        },
        invalidate: () => undefined,
      }),
    );
  }

  private refreshStatus(input: UiAdapterRefresh): void {
    if (!input.config.status.enabled) {
      this.setStatus(undefined);
      return;
    }

    try {
      this.setStatus(renderStatusText(input.state, input.currentTime));
    } catch {
      this.recordUiUnavailable('ui_failure');
      this.setStatus(undefined);
    }
  }

  private clearBoth(): void {
    this.setWidget(undefined);
    this.setStatus(undefined);
  }

  private setWidget(content: WidgetContent): void {
    this.callSurface('setWidget', (method, receiver) => {
      method.call(receiver, WIDGET_ID, content, { placement: 'aboveEditor' });
    });
  }

  private setStatus(text: string | undefined): void {
    this.callSurface('setStatus', (method, receiver) => {
      method.call(receiver, STATUS_ID, text);
    });
  }

  private callSurface(
    name: 'setWidget' | 'setStatus',
    invoke: (method: (...arguments_: unknown[]) => unknown, receiver: object) => void,
  ): void {
    try {
      const ui = this.#context.ui as unknown as Record<string, unknown>;
      const method = ui?.[name];
      if (typeof method !== 'function') {
        this.recordUiUnavailable('ui_unsupported');
        return;
      }
      invoke(method as (...arguments_: unknown[]) => unknown, ui);
    } catch {
      this.recordUiUnavailable('ui_failure');
    }
  }

  private recordUiUnavailable(category: DiagnosticSafeCategory): void {
    this.#diagnostics.record({
      at: this.#diagnosticTime,
      code: 'SB_UI_UNAVAILABLE',
      severity: 'warning',
      area: 'ui',
      category,
    });
  }
}

type WidgetFactory = () => Component;
type WidgetContent = WidgetFactory | undefined;

/** Compute the exact inclusive completion cutoff from one injected clock read. */
export function completionWindowCutoff(currentTime: Date, minutes: number): string {
  const duration = Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : 0;
  return new Date(currentTime.getTime() - duration).toISOString();
}

function normalizeTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : '1970-01-01T00:00:00.000Z';
}
