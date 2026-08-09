import type { AppState } from '../types';
import type { RecoveryAdapters } from './toolRecoveryEngine.js';
import {
  combineFileSnippetBatchRecoveryResults,
  splitFileSnippetBatchArgsForRecovery,
} from './localFileService.js';
import { refreshContextHandlePayloadForRecovery } from './contextHandleService.js';
import { refreshPreparedEditPreviewForRecovery } from './preparedEditService.js';
import { waitForToolJobResultForRecovery } from './mcpToolJobService.js';

export function createDevFlowRecoveryAdapters(
  state: AppState,
  toolName: string,
): RecoveryAdapters<Record<string, any>, any> {
  const normalized = String(toolName || '').trim();
  const adapters: RecoveryAdapters<Record<string, any>, any> = {};

  if (normalized === 'read_file_snippets_batch') {
    adapters.splitBatch = async (payload) => ({
      chunks: splitFileSnippetBatchArgsForRecovery(payload),
      combine: combineFileSnippetBatchRecoveryResults,
    });
  }

  if (normalized === 'get_repo_context_delta' || normalized === 'get_repo_context_bundle') {
    adapters.refreshContext = async (payload) => refreshContextHandlePayloadForRecovery(state, payload);
  }

  if (normalized === 'get_tool_job_result') {
    adapters.waitResult = waitForToolJobResultForRecovery;
  }

  if (normalized === 'search_local_files') {
    adapters.fallbackSearch = async (payload) => ({ ...payload, forceFallbackSearch: true });
  }

  if (normalized === 'apply_prepared_edit' || normalized === 'apply_prepared_edit_plan') {
    adapters.refreshPreview = async (payload) => refreshPreparedEditPreviewForRecovery(state, payload);
  }

  return adapters;
}
