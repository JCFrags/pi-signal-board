import { BOARD_TABS, type BoardTab } from '../ui/board/model.js';

export type SignalBoardCommand =
  | { readonly kind: 'open'; readonly tab?: BoardTab }
  | { readonly kind: 'summary' }
  | { readonly kind: 'doctor' }
  | { readonly kind: 'usage' };

const TAB_SET = new Set<string>(BOARD_TABS);

/** Parse only the exact case-sensitive Agent Board command grammar. */
export function parseSignalBoardCommand(raw: string): SignalBoardCommand {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return Object.freeze({ kind: 'open' });

  const tokens = trimmed.split(/\s+/u);
  if (tokens.length !== 1) return Object.freeze({ kind: 'usage' });
  const token = tokens[0] as string;
  if (TAB_SET.has(token)) {
    return Object.freeze({ kind: 'open', tab: token as BoardTab });
  }
  if (token === 'summary') return Object.freeze({ kind: 'summary' });
  if (token === 'doctor') return Object.freeze({ kind: 'doctor' });
  return Object.freeze({ kind: 'usage' });
}
