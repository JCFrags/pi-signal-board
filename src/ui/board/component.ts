import type { Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey } from '@earendil-works/pi-tui';

import type { AnswerId } from '../../domain/ids.js';
import { projectRecommendationAnswer } from '../../questions/validation/index.js';
import {
  BOARD_TABS,
  type BoardTab,
  type BoardViewModel,
  type InboxRow,
  type UpdateRow,
} from './model.js';
import { renderBoard } from './renderer.js';

export type SignalBoardAction =
  | { readonly type: 'close'; readonly tab: BoardTab }
  | {
      readonly type: 'answer' | 'accept_recommendation' | 'dismiss';
      readonly tab: 'inbox';
      readonly entityId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: 'retry_delivery';
      readonly tab: 'inbox';
      readonly entityId: string;
      readonly expectedRevision: number;
      readonly answerId: AnswerId;
    }
  | {
      readonly type: 'archive_update';
      readonly tab: 'updates';
      readonly entityId: string;
      readonly expectedRevision: number;
    };

export interface SignalBoardRenderHost {
  requestRender(): void;
}

export interface SignalBoardComponentOptions {
  readonly tui: SignalBoardRenderHost;
  readonly theme: Theme;
  readonly model: BoardViewModel;
  readonly done: (action: SignalBoardAction) => void;
}

/**
 * Render and navigate one immutable board snapshot. This component returns intent only.
 * It owns no timers, host handlers, product state, configuration, or clock.
 */
export class SignalBoardComponent {
  private host: SignalBoardRenderHost | undefined;
  private completion: ((action: SignalBoardAction) => void) | undefined;
  private readonly theme: Theme;
  private readonly model: BoardViewModel;
  private activeTab: BoardTab;
  private readonly selectedIndexes: Record<BoardTab, number>;
  private detailExpanded = false;
  private helpVisible = false;
  private closed = false;

  constructor(options: SignalBoardComponentOptions) {
    this.host = options.tui;
    this.completion = options.done;
    this.theme = options.theme;
    this.model = options.model;
    this.activeTab = options.model.activeTab;
    this.selectedIndexes = {
      inbox: selectedIndex(options.model.tabs.inbox.rows),
      updates: selectedIndex(options.model.tabs.updates.rows),
      decisions: selectedIndex(options.model.tabs.decisions.rows),
      history: selectedIndex(options.model.tabs.history.rows),
    };
  }

  render(width: number): string[] {
    const inboxRow = this.activeTab === 'inbox' ? this.currentInboxRow() : undefined;
    return renderBoard({
      width,
      theme: this.theme,
      model: this.model,
      activeTab: this.activeTab,
      selectedIndex: this.selectedIndexes[this.activeTab],
      detailExpanded: this.detailExpanded,
      helpVisible: this.helpVisible,
      recommendationAvailable:
        inboxRow === undefined ? false : this.hasValidRecommendation(inboxRow),
    });
  }

  handleInput(data: string): void {
    if (this.closed) return;

    if (this.helpVisible) {
      if (matchesKey(data, Key.escape) || data === '?') {
        this.helpVisible = false;
        this.changed();
      }
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.finish({ type: 'close', tab: this.activeTab });
      return;
    }
    if (data === '?') {
      this.helpVisible = true;
      this.changed();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.moveTab(1);
      return;
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.moveTab(-1);
      return;
    }
    if (matchesKey(data, Key.up) || data === 'k') {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down) || data === 'j') {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.detailExpanded = !this.detailExpanded;
      this.changed();
      return;
    }

    this.handleContextualAction(data.toLowerCase());
  }

  /** Theme content is computed during render. Invalidation still requests a fresh host render. */
  invalidate(): void {
    if (!this.closed) this.host?.requestRender();
  }

  /** Release callback and host references. Pi may call this during component disposal. */
  dispose(): void {
    this.closed = true;
    this.host = undefined;
    this.completion = undefined;
  }

  private handleContextualAction(key: string): void {
    if (this.activeTab === 'inbox') {
      const row = this.currentInboxRow();
      if (row === undefined) return;
      if (key === 'a' && row.userAnswerable) {
        this.finish(questionAction('answer', row));
      } else if (key === 'r' && row.userAnswerable && this.hasValidRecommendation(row)) {
        this.finish(questionAction('accept_recommendation', row));
      } else if (key === 'x' && row.userAnswerable) {
        this.finish(questionAction('dismiss', row));
      } else if (key === 'y' && row.retryableDelivery) {
        const answerId = this.answerIdFor(row);
        if (answerId !== undefined) {
          this.finish({
            type: 'retry_delivery',
            tab: 'inbox',
            entityId: row.entityId,
            expectedRevision: row.revision,
            answerId,
          });
        }
      }
      return;
    }

    if (this.activeTab === 'updates' && key === 'h') {
      const row = this.currentUpdateRow();
      if (row !== undefined && isArchiveEligible(row)) {
        this.finish({
          type: 'archive_update',
          tab: 'updates',
          entityId: row.entityId,
          expectedRevision: row.revision,
        });
      }
    }
  }

  private moveTab(direction: 1 | -1): void {
    const current = BOARD_TABS.indexOf(this.activeTab);
    this.activeTab = BOARD_TABS[
      (current + direction + BOARD_TABS.length) % BOARD_TABS.length
    ] as BoardTab;
    this.detailExpanded = false;
    this.changed();
  }

  private moveSelection(direction: 1 | -1): void {
    const rows = this.model.tabs[this.activeTab].rows;
    if (rows.length === 0) return;
    const current = this.selectedIndexes[this.activeTab];
    this.selectedIndexes[this.activeTab] = (current + direction + rows.length) % rows.length;
    this.detailExpanded = false;
    this.changed();
  }

  private changed(): void {
    this.host?.requestRender();
  }

  private finish(action: SignalBoardAction): void {
    const done = this.completion;
    this.closed = true;
    this.host = undefined;
    this.completion = undefined;
    done?.(action);
  }

  private currentInboxRow(): InboxRow | undefined {
    return this.model.tabs.inbox.rows[this.selectedIndexes.inbox];
  }

  private currentUpdateRow(): UpdateRow | undefined {
    return this.model.tabs.updates.rows[this.selectedIndexes.updates];
  }

  private hasValidRecommendation(row: InboxRow): boolean {
    const detail = this.model.tabs.inbox.detailsById[row.entityId];
    if (detail === undefined) return false;
    try {
      return projectRecommendationAnswer(detail.projection.item) !== undefined;
    } catch {
      return false;
    }
  }

  private answerIdFor(row: InboxRow): AnswerId | undefined {
    const detail = this.model.tabs.inbox.detailsById[row.entityId];
    if (detail === undefined) return undefined;
    return detail.projection.answer?.id;
  }
}

function selectedIndex(rows: readonly { readonly selected: boolean }[]): number {
  const index = rows.findIndex((row) => row.selected);
  return index < 0 ? 0 : index;
}

function questionAction(
  type: 'answer' | 'accept_recommendation' | 'dismiss',
  row: InboxRow,
): SignalBoardAction {
  return {
    type,
    tab: 'inbox',
    entityId: row.entityId,
    expectedRevision: row.revision,
  };
}

function isArchiveEligible(row: UpdateRow): boolean {
  return row.kind === 'completed' || row.kind === 'failed';
}
