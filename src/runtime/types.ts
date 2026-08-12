import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { ConfigLoadResult } from '../config/types.js';
import type { SignalBoardError } from '../domain/errors.js';
import type { BoardState } from '../domain/types.js';
import type { CompatibilityResult } from '../integration/compatibility.js';
import type { SessionHealthSnapshot, SessionPersistence } from '../integration/doctor.js';
import type { Diagnostics } from '../services/diagnostics.js';
import type { MutationQueue } from '../services/mutation-queue.js';

export type RuntimeStatus = 'healthy' | 'degraded' | 'disabled' | 'unsupported';

export interface RuntimeIdentity {
  readonly persistence: SessionPersistence;
  readonly token: string;
}

/** Session state owned by one lifecycle generation. */
export interface SignalBoardRuntime {
  readonly generation: number;
  readonly identity: RuntimeIdentity;
  readonly context: ExtensionContext;
  readonly queue: MutationQueue;
  readonly compatibility: CompatibilityResult;
  readonly config: ConfigLoadResult;
  readonly diagnostics: Diagnostics;
  state: BoardState;
  status: RuntimeStatus;
  timer: unknown | undefined;
  disposed: boolean;
  disposeCount: number;
  notifications: Set<string>;
}

export type RuntimeAccessErrorCode =
  | 'SB_NOT_INITIALIZED'
  | 'SB_DISABLED'
  | 'SB_UNSUPPORTED_HOST'
  | 'SB_INTERNAL';

export interface RuntimeAccessError {
  readonly code: RuntimeAccessErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type RuntimeAccessResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RuntimeAccessError };

export interface RuntimeDoctorSource {
  doctorSnapshot(context: ExtensionContext): SessionHealthSnapshot;
}

export interface RuntimeLifecycleHooks {
  /** Locked startup hooks are intentionally injectable until their services exist. */
  readonly evaluateExpiryLocked?: (runtime: SignalBoardRuntime) => void | Promise<void>;
  readonly recoverDeliveryLocked?: (runtime: SignalBoardRuntime) => void | Promise<void>;
  readonly refreshLocked?: (runtime: SignalBoardRuntime) => void | Promise<void>;
  readonly onTimerLocked?: (runtime: SignalBoardRuntime) => void | Promise<void>;
  readonly armTimerLocked?: (
    runtime: SignalBoardRuntime,
    callback: () => Promise<void>,
  ) => unknown | Promise<unknown | undefined>;
  readonly clearTimer?: (handle: unknown) => void;
}

/** Future services can convert runtime access failures to the shared public error type. */
export type RuntimeMutationBoundary<T> =
  | RuntimeAccessResult<T>
  | { ok: false; error: SignalBoardError };
