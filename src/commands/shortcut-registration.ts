import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { SHORTCUT, SHORTCUT_DESCRIPTION } from '../constants.js';

export type ShortcutAvailability = 'available' | 'unavailable';

export interface ShortcutRegistration {
  readonly availability: ShortcutAvailability;
}

export interface SignalBoardShortcutDependencies {
  readonly openBoard: (context: ExtensionContext) => Promise<void>;
  readonly onFailure: (context: ExtensionContext) => void;
}

/** Register the fixed shortcut once. A host conflict leaves the command path unchanged. */
export function registerSignalBoardShortcut(
  pi: Pick<ExtensionAPI, 'registerShortcut'>,
  dependencies: SignalBoardShortcutDependencies,
): ShortcutRegistration {
  try {
    pi.registerShortcut(SHORTCUT, {
      description: SHORTCUT_DESCRIPTION,
      handler: async (context) => {
        try {
          await dependencies.openBoard(context);
        } catch {
          try {
            dependencies.onFailure(context);
          } catch {
            // A failed diagnostic surface must not escape the shortcut boundary.
          }
        }
      },
    });
    return Object.freeze({ availability: 'available' });
  } catch {
    return Object.freeze({ availability: 'unavailable' });
  }
}
