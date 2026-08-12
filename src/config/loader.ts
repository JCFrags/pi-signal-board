import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent';

import { CONFIG_FILE_NAME, MAX_CONFIG_BYTES } from '../constants.js';
import { DEFAULT_CONFIG, deepFreeze } from './defaults.js';
import { type ConfigDocument, isConfigDocument } from './schema.js';
import type {
  ConfigLoadResult,
  ConfigSource,
  ConfigSourceStatus,
  ConfigWarning,
  EffectiveConfig,
} from './types.js';

export interface ConfigLoadContext {
  readonly cwd: string;
  isProjectTrusted(): boolean;
}

export type FixedConfigReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly text: string }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'invalid_encoding' }
  | {
      readonly kind: 'unreadable';
      readonly safeCategory: 'access_denied' | 'wrong_type' | 'io_error';
    };

/** Testable, narrow reader. The loader, not its caller, selects both fixed paths. */
export interface FixedConfigReader {
  readUtf8Capped(absoluteFixedPath: string): Promise<FixedConfigReadResult>;
}

function classifyReadError(error: unknown): FixedConfigReadResult {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    if (code === 'EACCES' || code === 'EPERM') {
      return { kind: 'unreadable', safeCategory: 'access_denied' };
    }
    if (code === 'EISDIR') return { kind: 'unreadable', safeCategory: 'wrong_type' };
  }
  return { kind: 'unreadable', safeCategory: 'io_error' };
}

const nodeFixedConfigReader: FixedConfigReader = {
  async readUtf8Capped(absoluteFixedPath): Promise<FixedConfigReadResult> {
    try {
      const handle = await open(absoluteFixedPath, 'r');
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
          return { kind: 'unreadable', safeCategory: 'wrong_type' };
        }
        if (metadata.size > MAX_CONFIG_BYTES) return { kind: 'too_large' };

        // The extra byte proves that a file exceeds the cap without an unbounded load.
        const bytes = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
        let total = 0;
        while (total < bytes.length) {
          const result = await handle.read(bytes, total, bytes.length - total, null);
          if (result.bytesRead === 0) break;
          total += result.bytesRead;
        }
        if (total > MAX_CONFIG_BYTES) return { kind: 'too_large' };

        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total));
          return { kind: 'present', text };
        } catch {
          return { kind: 'invalid_encoding' };
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      return classifyReadError(error);
    }
  },
};

function mergeConfig(base: EffectiveConfig, document: ConfigDocument): EffectiveConfig {
  return {
    schemaVersion: 1,
    enabled: document.enabled ?? base.enabled,
    widget: {
      enabled: document.widget?.enabled ?? base.widget.enabled,
      placement: document.widget?.placement ?? base.widget.placement,
      maxItems: document.widget?.maxItems ?? base.widget.maxItems,
      showCompletedForMinutes:
        document.widget?.showCompletedForMinutes ?? base.widget.showCompletedForMinutes,
      hideWhenClear: document.widget?.hideWhenClear ?? base.widget.hideWhenClear,
    },
    status: {
      enabled: document.status?.enabled ?? base.status.enabled,
      hideWhenClear: document.status?.hideWhenClear ?? base.status.hideWhenClear,
    },
    notifications: {
      highPriorityQuestion:
        document.notifications?.highPriorityQuestion ?? base.notifications.highPriorityQuestion,
      questionEscalated:
        document.notifications?.questionEscalated ?? base.notifications.questionEscalated,
      deliveryFailed: document.notifications?.deliveryFailed ?? base.notifications.deliveryFailed,
      normalQuestion: document.notifications?.normalQuestion ?? base.notifications.normalQuestion,
      updateCompleted:
        document.notifications?.updateCompleted ?? base.notifications.updateCompleted,
    },
    questions: {
      defaultDeliveryMode:
        document.questions?.defaultDeliveryMode ?? base.questions.defaultDeliveryMode,
      defaultBlockingPolicy:
        document.questions?.defaultBlockingPolicy ?? base.questions.defaultBlockingPolicy,
      recoveryDeliveryOnStart:
        document.questions?.recoveryDeliveryOnStart ?? base.questions.recoveryDeliveryOnStart,
    },
    limits: {
      maxActiveUpdates: document.limits?.maxActiveUpdates ?? base.limits.maxActiveUpdates,
      maxActionableQuestions:
        document.limits?.maxActionableQuestions ?? base.limits.maxActionableQuestions,
      visibleHistoryLimit: document.limits?.visibleHistoryLimit ?? base.limits.visibleHistoryLimit,
      maxUpdateMutationsPerTurn:
        document.limits?.maxUpdateMutationsPerTurn ?? base.limits.maxUpdateMutationsPerTurn,
      maxQuestionMutationsPerTurn:
        document.limits?.maxQuestionMutationsPerTurn ?? base.limits.maxQuestionMutationsPerTurn,
      maxAcknowledgementsPerTurn:
        document.limits?.maxAcknowledgementsPerTurn ?? base.limits.maxAcknowledgementsPerTurn,
    },
    ui: {
      wideLayoutMinimumColumns:
        document.ui?.wideLayoutMinimumColumns ?? base.ui.wideLayoutMinimumColumns,
      minimumColumns: document.ui?.minimumColumns ?? base.ui.minimumColumns,
      showRelativeTime: document.ui?.showRelativeTime ?? base.ui.showRelativeTime,
    },
    debug: {
      enabled: document.debug?.enabled ?? base.debug.enabled,
      showAnswerMessages: document.debug?.showAnswerMessages ?? base.debug.showAnswerMessages,
    },
  };
}

function isSemanticallyValid(config: EffectiveConfig): boolean {
  return config.ui.minimumColumns <= config.ui.wideLayoutMinimumColumns;
}

interface AppliedDocument {
  readonly config: EffectiveConfig;
  readonly status: ConfigSourceStatus;
  readonly warning?: ConfigWarning;
}

async function applyDocument(
  source: ConfigSource,
  path: string,
  base: EffectiveConfig,
  reader: FixedConfigReader,
): Promise<AppliedDocument> {
  const readResult = await reader.readUtf8Capped(path);
  switch (readResult.kind) {
    case 'absent':
      return { config: base, status: 'absent' };
    case 'too_large':
      return { config: base, status: 'rejected', warning: { source, reason: 'too_large' } };
    case 'invalid_encoding':
      return {
        config: base,
        status: 'rejected',
        warning: { source, reason: 'invalid_encoding' },
      };
    case 'unreadable':
      return {
        config: base,
        status: 'rejected',
        warning: { source, reason: 'unreadable', safeCategory: readResult.safeCategory },
      };
    case 'present':
      break;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readResult.text);
  } catch {
    return {
      config: base,
      status: 'rejected',
      warning: { source, reason: 'malformed_json' },
    };
  }

  if (!isConfigDocument(parsed)) {
    return { config: base, status: 'rejected', warning: { source, reason: 'invalid_schema' } };
  }

  const candidate = mergeConfig(base, parsed);
  if (!isSemanticallyValid(candidate)) {
    return {
      config: base,
      status: 'rejected',
      warning: { source, reason: 'invalid_semantics' },
    };
  }

  return { config: candidate, status: 'applied' };
}

/**
 * Load defaults, the fixed global file, then the fixed trusted-project file.
 * The trust check occurs before project path construction or reader access.
 */
export async function loadConfiguration(
  context: ConfigLoadContext,
  reader: FixedConfigReader = nodeFixedConfigReader,
): Promise<ConfigLoadResult> {
  const warnings: ConfigWarning[] = [];
  let effective = mergeConfig(DEFAULT_CONFIG, { schemaVersion: 1 });

  const global = await applyDocument(
    'global',
    join(getAgentDir(), CONFIG_FILE_NAME),
    effective,
    reader,
  );
  effective = global.config;
  if (global.warning) warnings.push(global.warning);

  if (!context.isProjectTrusted()) {
    return {
      config: deepFreeze(effective),
      sources: { global: global.status, project: 'not_read_untrusted' },
      warnings,
    };
  }

  const project = await applyDocument(
    'project',
    join(context.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
    effective,
    reader,
  );
  effective = project.config;
  if (project.warning) warnings.push(project.warning);

  return {
    config: deepFreeze(effective),
    sources: { global: global.status, project: project.status },
    warnings,
  };
}
