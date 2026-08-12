/** Stable package and product identifiers. */
export const PRODUCT_ID = 'pi-signal-board';
export const PRODUCT_NAME = 'Pi Signal Board';
export const PRODUCT_VERSION = '0.1.0';

/** Version ranges enforced by host compatibility checks. */
export const SUPPORTED_NODE_RANGE = '>=22.19.0';
export const SUPPORTED_PI_RANGE = '>=0.84.1 <0.85.0';
export const MINIMUM_NODE_VERSION = '22.19.0';
export const MINIMUM_PI_VERSION = '0.84.1';
export const EXCLUSIVE_MAXIMUM_PI_VERSION = '0.85.0';

/** Pi custom entry and custom message types. */
export const EVENT_CUSTOM_TYPE = 'pi-signal-board/event';
export const ANSWER_CUSTOM_TYPE = 'pi-signal-board/answer';

/** Namespaced Pi UI surface identifiers. */
export const WIDGET_ID = PRODUCT_ID;
export const STATUS_ID = PRODUCT_ID;

/** Static command and shortcut registration values. */
export const COMMAND_NAME = 'signalboard';
export const COMMAND_INVOCATION = '/signalboard';
export const SHORTCUT = 'ctrl+shift+b';
export const SHORTCUT_DISPLAY = 'Ctrl+Shift+B';
export const SHORTCUT_DESCRIPTION = 'Open Pi Signal Board';

/** Static agent tool names. */
export const UPDATE_TOOL_NAME = 'signal_board_update';
export const QUESTION_TOOL_NAME = 'signal_board_question';
export const ACK_TOOL_NAME = 'signal_board_ack';
export const TOOL_NAMES = [UPDATE_TOOL_NAME, QUESTION_TOOL_NAME, ACK_TOOL_NAME] as const;

/** Fixed configuration file facts used by the later configuration lane. */
export const CONFIG_FILE_NAME = 'pi-signal-board.json';
export const MAX_CONFIG_BYTES = 64 * 1024;
