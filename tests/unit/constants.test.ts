import { describe, expect, it } from 'vitest';

import {
  ACK_TOOL_NAME,
  ANSWER_CUSTOM_TYPE,
  COMMAND_INVOCATION,
  COMMAND_NAME,
  CONFIG_FILE_NAME,
  EVENT_CUSTOM_TYPE,
  MAX_CONFIG_BYTES,
  PRODUCT_ID,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  QUESTION_TOOL_NAME,
  SHORTCUT,
  SHORTCUT_DESCRIPTION,
  SHORTCUT_DISPLAY,
  STATUS_ID,
  SUPPORTED_NODE_RANGE,
  SUPPORTED_PI_RANGE,
  TOOL_NAMES,
  UPDATE_TOOL_NAME,
  WIDGET_ID,
} from '../../src/constants.js';

describe('product constants', () => {
  it('exports the exact package and compatibility facts', () => {
    expect({ PRODUCT_ID, PRODUCT_NAME, PRODUCT_VERSION }).toEqual({
      PRODUCT_ID: 'pi-signal-board',
      PRODUCT_NAME: 'Pi Signal Board',
      PRODUCT_VERSION: '0.1.0',
    });
    expect(SUPPORTED_NODE_RANGE).toBe('>=22.19.0');
    expect(SUPPORTED_PI_RANGE).toBe('>=0.84.1 <0.85.0');
  });

  it('exports the exact Pi integration identifiers', () => {
    expect(EVENT_CUSTOM_TYPE).toBe('pi-signal-board/event');
    expect(ANSWER_CUSTOM_TYPE).toBe('pi-signal-board/answer');
    expect(WIDGET_ID).toBe('pi-signal-board');
    expect(STATUS_ID).toBe('pi-signal-board');
    expect(COMMAND_NAME).toBe('signalboard');
    expect(COMMAND_INVOCATION).toBe('/signalboard');
    expect(SHORTCUT).toBe('ctrl+shift+b');
    expect(SHORTCUT_DISPLAY).toBe('Ctrl+Shift+B');
    expect(SHORTCUT_DESCRIPTION).toBe('Open Pi Signal Board');
  });

  it('exports exact tool and configuration facts for later lanes', () => {
    expect(TOOL_NAMES).toEqual([
      'signal_board_update',
      'signal_board_question',
      'signal_board_ack',
    ]);
    expect(UPDATE_TOOL_NAME).toBe(TOOL_NAMES[0]);
    expect(QUESTION_TOOL_NAME).toBe(TOOL_NAMES[1]);
    expect(ACK_TOOL_NAME).toBe(TOOL_NAMES[2]);
    expect(CONFIG_FILE_NAME).toBe('pi-signal-board.json');
    expect(MAX_CONFIG_BYTES).toBe(65_536);
  });
});
