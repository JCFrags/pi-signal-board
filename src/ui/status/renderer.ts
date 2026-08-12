import { selectBoardCounts } from '../../domain/selectors.js';
import type { BoardState } from '../../domain/types.js';

/** Build the no-color footer status from accepted selector counts. */
export function renderStatusText(state: BoardState, currentTime: string): string | undefined {
  const counts = selectBoardCounts(state, currentTime);
  if (counts.actionableQuestions === 0 && counts.activeUpdates === 0 && counts.unread === 0) {
    return undefined;
  }

  const unread = counts.unread > 0 ? ` ${counts.unread} new` : '';
  return `Signal: ${counts.actionableQuestions}Q ${counts.activeUpdates}U${unread}`;
}
