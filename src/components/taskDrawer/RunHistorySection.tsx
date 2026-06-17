export interface RunHistorySectionProps {
  taskId: string;
}

export function RunHistorySection({ taskId }: RunHistorySectionProps) {
  return (
    <section data-section="runHistory" aria-label="Run History">
      <p>
        Run history for <code>{taskId}</code> is loaded by the agent-run view-model.
      </p>
    </section>
  );
}
