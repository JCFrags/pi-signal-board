import { describe, expect, it } from 'vitest';

import signalBoardExtension from '../src/index.js';

describe('package scaffold', () => {
  it('exports one extension registration function', () => {
    expect(typeof signalBoardExtension).toBe('function');
  });
});
