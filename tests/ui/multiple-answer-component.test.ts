import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import type { OptionId, QuestionOption } from '../../src/domain/types.js';
import {
  MultipleAnswerComponent,
  type MultipleAnswerSelectionResult,
} from '../../src/ui/board/multiple-answer-component.js';

const OPTIONS: readonly QuestionOption[] = [
  { id: 'linux', label: 'Linux' },
  { id: 'macos', label: 'macOS' },
  { id: 'windows', label: `Windows ${'漢🙂'.repeat(100)}` },
];

function component(
  input: { selected?: readonly OptionId[]; textSupported?: boolean; textPresent?: boolean } = {},
) {
  const results: MultipleAnswerSelectionResult[] = [];
  const host = { requestRender: vi.fn() };
  const board = new MultipleAnswerComponent({
    tui: host,
    displayId: 'Q-32',
    options: OPTIONS,
    ...(input.selected === undefined ? {} : { selectedOptionIds: input.selected }),
    textSupported: input.textSupported ?? false,
    ...(input.textPresent === undefined ? {} : { textPresent: input.textPresent }),
    done: (result) => results.push(result),
  });
  return { board, host, results };
}

function output(board: MultipleAnswerComponent, width = 80): string {
  return board.render(width).join('\n');
}

describe('SB-032 multiple answer keyboard component', () => {
  it('wraps arrow and j/k navigation and toggles independent textual checkboxes', () => {
    const { board, host } = component();
    board.handleInput('\u001b[A');
    board.handleInput(' ');
    expect(output(board)).toContain('> [x] Windows');
    board.handleInput('j');
    board.handleInput(' ');
    expect(output(board)).toContain('> [x] Linux');
    board.handleInput('k');
    expect(output(board)).toContain('> [x] Windows');
    expect(host.requestRender).toHaveBeenCalledTimes(5);
  });

  it('does not submit an empty multiple answer and submits IDs in schema order', () => {
    const { board, results } = component();
    board.handleInput('\r');
    expect(results).toEqual([]);
    board.handleInput('\u001b[B');
    board.handleInput(' ');
    board.handleInput('\u001b[A');
    board.handleInput(' ');
    board.handleInput('\r');
    expect(results).toEqual([{ kind: 'submit', optionIds: ['linux', 'macos'] }]);
    const result = results[0];
    expect(result?.kind).toBe('submit');
    if (result?.kind !== 'submit') throw new Error('Expected submit result.');
    expect(Object.isFrozen(result.optionIds)).toBe(true);
  });

  it('returns text only when supported and permits Enter when valid text is present', () => {
    const unsupported = component();
    unsupported.board.handleInput('T');
    expect(unsupported.results).toEqual([]);

    const text = component({ textSupported: true });
    text.board.handleInput('t');
    expect(text.results).toEqual([{ kind: 'text', optionIds: [] }]);

    const present = component({ textSupported: true, textPresent: true });
    present.board.handleInput('\r');
    expect(present.results).toEqual([{ kind: 'submit', optionIds: [] }]);
  });

  it('cancels with Escape once and releases callbacks and host references', () => {
    const { board, host, results } = component();
    board.handleInput('\u001b');
    board.handleInput('\u001b');
    board.invalidate();
    board.dispose();
    expect(results).toEqual([{ kind: 'cancelled' }]);
    expect(host.requestRender).not.toHaveBeenCalled();
  });

  it.each([1, 20, 49, 50, 80, 99, 100, 160])(
    'keeps long Unicode labels width-safe at %i cells',
    (width) => {
      const lines = component({ textSupported: true }).board.render(width);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(lines.join('\n')).not.toContain('\u001b');
    },
  );

  it('matches stable no-color golden text at 50 columns', () => {
    const board = component({ selected: ['linux'], textSupported: true }).board;
    expect(board.render(50)).toMatchInlineSnapshot(`
      [
        "Answer Q-32 · select one or more",
        "──────────────────────────────────────────────────",
        "> [x] Linux",
        "  [ ] macOS",
        "  [ ] Windows 漢🙂漢🙂漢🙂漢🙂漢🙂漢🙂漢🙂漢🙂漢…",
        "Text answer: [none]",
        "──────────────────────────────────────────────────",
        "↑↓/jk move · Space toggle · Enter submit · T text",
        "Esc cancel",
      ]
    `);
  });

  it('is deterministic for fixed-seed option permutations and prints the seed on failure', () => {
    const seed = 0x5b032;
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    try {
      for (let run = 0; run < 100; run += 1) {
        const order = [...OPTIONS].sort(() => (next() & 1) * 2 - 1);
        const results: MultipleAnswerSelectionResult[] = [];
        const board = new MultipleAnswerComponent({
          tui: { requestRender: () => undefined },
          displayId: 'Q-32',
          options: order,
          selectedOptionIds: order.map((option) => option.id),
          textSupported: false,
          done: (result) => results.push(result),
        });
        board.handleInput('\r');
        expect(results[0], `seed=${seed} case=${run}`).toEqual({
          kind: 'submit',
          optionIds: order.map((option) => option.id),
        });
      }
    } catch (error) {
      console.error(`multiple-component property seed=${seed} state=${state}`);
      throw error;
    }
  });
});
