import { useEffect, useMemo, useState } from 'react';
import type { Task } from '../../types';

export interface RunHistoryFiles {
  runDir: string;
  promptPath: string;
  logPath: string;
  launchMetadataPath: string;
  outputSummaryPath: string;
  resultPath: string;
}

export function useRunArtifacts(task: Task) {
  const [runHistoryFiles, setRunHistoryFiles] = useState<RunHistoryFiles | null>(null);
  const [latestRunLogContent, setLatestRunLogContent] = useState('');
  const [latestRunLogExists, setLatestRunLogExists] = useState(false);
  const [latestRunLogLoading, setLatestRunLogLoading] = useState(false);
  const [latestRunLogError, setLatestRunLogError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRunHistoryFiles(null);

    const runId = task.latestAgentRun?.id;
    if (!runId) return;

    fetch(`/api/tasks/${task.id}/agent-runs/${runId}/history`)
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((data) => {
        if (cancelled || !data?.files) return;
        setRunHistoryFiles(data.files);
      })
      .catch(() => {
        if (!cancelled) setRunHistoryFiles(null);
      });

    return () => {
      cancelled = true;
    };
  }, [task.id, task.latestAgentRun?.id]);

  useEffect(() => {
    let cancelled = false;
    setLatestRunLogContent('');
    setLatestRunLogExists(false);
    setLatestRunLogError(null);

    const runId = task.latestAgentRun?.id;
    if (!runId) return;

    setLatestRunLogLoading(true);
    fetch(`/api/tasks/${task.id}/agent-runs/${runId}/log`)
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(data?.error || `Failed to load log (${response.status})`);
        }
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setLatestRunLogContent(typeof data?.content === 'string' ? data.content : '');
        setLatestRunLogExists(Boolean(data?.exists));
      })
      .catch((error) => {
        if (cancelled) return;
        setLatestRunLogError(error?.message || 'Failed to load log');
      })
      .finally(() => {
        if (!cancelled) setLatestRunLogLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [task.id, task.latestAgentRun?.id]);

  const latestRunLogTail = useMemo(() => (
    latestRunLogContent.trim()
      ? latestRunLogContent.trimEnd().split(/\r?\n/).slice(-40).join('\n')
      : ''
  ), [latestRunLogContent]);

  return {
    runHistoryFiles,
    latestRunLogExists,
    latestRunLogLoading,
    latestRunLogError,
    latestRunLogTail,
  };
}
