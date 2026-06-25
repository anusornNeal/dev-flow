import type React from 'react';
import { Activity, ChevronDown, Clipboard, Plus } from 'lucide-react';
import type { Task } from '../../types';
import type { RunHistoryFiles } from './useRunArtifacts';

interface TaskDrawerActivityPanelProps {
  task: Task;
  openSections: Set<string>;
  handleAccordionClick: (e: React.MouseEvent<HTMLButtonElement>, key: string) => void;
  activeLogTab: 'notes' | 'autowork' | 'history';
  setActiveLogTab: (tab: 'notes' | 'autowork' | 'history') => void;
  newComment: string;
  setNewComment: (value: string) => void;
  handleAddComment: (e: React.FormEvent) => void;
  latestRun: Task['latestAgentRun'];
  autoWorkState: { label?: string; message?: string } | null | undefined;
  canRetryLatestRun: boolean;
  handleRetryLatestRun: () => void;
  isRetryingRun: boolean;
  latestRunLogLoading: boolean;
  latestRunLogError: string | null;
  latestRunLogExists: boolean;
  latestRunLogTail: string;
  runHistoryFiles: RunHistoryFiles | null;
  copiedHistoryPath: string | null;
  handleCopyHistoryPath: (pathValue: string) => void;
  onShowLog?: (run: { id: string; status?: string; agent?: string | null; model?: string | null }) => void;
}

export function TaskDrawerActivityPanel({
  task,
  openSections,
  handleAccordionClick,
  activeLogTab,
  setActiveLogTab,
  newComment,
  setNewComment,
  handleAddComment,
  latestRun,
  autoWorkState,
  canRetryLatestRun,
  handleRetryLatestRun,
  isRetryingRun,
  latestRunLogLoading,
  latestRunLogError,
  latestRunLogExists,
  latestRunLogTail,
  runHistoryFiles,
  copiedHistoryPath,
  handleCopyHistoryPath,
  onShowLog,
}: TaskDrawerActivityPanelProps) {
  return (
    <>
          {/* Activity Logs */}
          <div className="border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl overflow-hidden bg-[#fffdfa] dark:bg-[#292119]">
            <button
              type="button"
              onClick={(e) => handleAccordionClick(e, 'activity')}
              className="w-full flex items-center justify-between p-3.5 hover:bg-[#f4ebd9] dark:bg-[#292119]/30 dark:hover:bg-[#3a2f26]/30 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-[#e5a93b]/10 dark:bg-[#e5a93b]/20 flex items-center justify-center">
                  <Activity size={12} className="text-[#e5a93b] dark:text-[#d6b56d]" />
                </div>
                <span className="text-xs font-bold text-[#5c493c] dark:text-[#f3eadf]">Activity & Logs</span>
                <span className="px-1.5 py-0.5 rounded-md bg-[#f4ebd9] dark:bg-[#3a2f26] text-[9px] font-mono font-bold text-[#8a6e5a] dark:text-[#b8ab9f]">
                  {task.logs.length}
                </span>
              </div>
              <ChevronDown 
                size={14} 
                className={`text-[#c4b3a4] dark:text-[#8a7a6a] transition-transform duration-200 ${openSections.has('activity') ? 'rotate-180' : ''}`}
              />
            </button>
            
            {openSections.has('activity') && (
              <div className="border-t border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf7]/50 dark:bg-[#292119]/50 p-0">
                {/* Tabs Header */}
                <div className="flex items-center gap-4 px-4 pt-3 border-b border-[#ebdcb9]/40 dark:border-[#584a3b]/40">
                  <button
                    type="button"
                    onClick={() => setActiveLogTab('notes')}
                    className={`pb-2 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors border-b-2 cursor-pointer ${
                      activeLogTab === 'notes' 
                        ? 'text-[#d89745] dark:text-[#d6b56d] border-[#d89745] dark:border-[#d6b56d]' 
                        : 'text-[#a59182] dark:text-[#8a7a6a] border-transparent hover:text-[#5c493c] dark:hover:text-[#f3eadf]'
                    }`}
                  >
                    Notes ({task.logs.filter(l => l.type === 'comment').length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveLogTab('autowork')}
                    className={`pb-2 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors border-b-2 cursor-pointer ${
                      activeLogTab === 'autowork' 
                        ? 'text-[#d89745] dark:text-[#d6b56d] border-[#d89745] dark:border-[#d6b56d]' 
                        : 'text-[#a59182] dark:text-[#8a7a6a] border-transparent hover:text-[#5c493c] dark:hover:text-[#f3eadf]'
                    }`}
                  >
                    Auto-Work
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveLogTab('history')}
                    className={`pb-2 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors border-b-2 cursor-pointer ${
                      activeLogTab === 'history' 
                        ? 'text-[#d89745] dark:text-[#d6b56d] border-[#d89745] dark:border-[#d6b56d]' 
                        : 'text-[#a59182] dark:text-[#8a7a6a] border-transparent hover:text-[#5c493c] dark:hover:text-[#f3eadf]'
                    }`}
                  >
                    History ({task.logs.filter(l => l.type !== 'comment').length})
                  </button>
                </div>

                <div className="p-4 space-y-4">
                  {/* NOTES TAB */}
                  {activeLogTab === 'notes' && (
                    <>
                      <div className="space-y-2 max-h-96 overflow-y-auto pr-1 scrollbar-thin">
                        {[...task.logs]
                          .filter(log => log.type === 'comment')
                          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                          .map((log) => (
                            <div 
                              key={log.id} 
                              className="p-3 rounded-xl border flex flex-col gap-1 text-[10px] font-mono leading-relaxed shadow-3xs transition-all bg-[#fffdfa] dark:bg-[#292119] border-[#ebdcb9] dark:border-[#584a3b] text-[#55453B] dark:text-[#f3eadf]"
                            >
                              <div className="flex justify-between items-center text-[8px] text-[#a08b7e] dark:text-[#d6b56d] font-extrabold uppercase mb-1">
                                <span className="flex items-center gap-1 text-[#d89745] dark:text-[#d6b56d]">
                                  <Clipboard size={10} />
                                  Note
                                </span>
                                <span>{new Date(log.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
                              </div>
                              <p className="whitespace-pre-wrap">{log.message.replace(/^💬 Note: /, '')}</p>
                            </div>
                          ))}
                        {task.logs.filter(l => l.type === 'comment').length === 0 && (
                          <div className="text-center py-4 text-[10px] font-mono text-[#a59182] dark:text-[#8a7a6a]">
                            No notes yet. Add one below.
                          </div>
                        )}
                      </div>
                      
                      <form onSubmit={handleAddComment} className="flex gap-2 font-mono mt-2">
                        <input
                          type="text"
                          className="flex-1 bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3.5 py-2 text-xs text-[#534135] dark:text-[#f3eadf] placeholder-[#c4b3a4] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-mono shadow-2xs"
                          placeholder="Write a note or comment..."
                          value={newComment}
                          onChange={(e) => setNewComment(e.target.value)}
                        />
                        <button
                          type="submit"
                          className="bg-[#fff9ee] dark:bg-[#292119] hover:bg-[#ebdcb9] dark:bg-[#584a3b] dark:hover:bg-[#584a3b] text-[#856b5a] dark:text-[#f3eadf] border border-[#ebdcb9] dark:border-[#584a3b] px-4 rounded-xl flex items-center justify-center cursor-pointer transition-colors hover:shadow-2xs"
                          title="Add Note"
                        >
                          <Plus size={15} />
                        </button>
                      </form>
                    </>
                  )}

                  {/* AUTO-WORK TAB */}
                  {activeLogTab === 'autowork' && (
                    <div className="space-y-4">
                      {latestRun ? (
                        <div className="bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl p-3 space-y-2 shadow-2xs">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-[10px] font-mono uppercase tracking-widest text-[#8a6e5a] dark:text-[#f3eadf] font-extrabold">
                                Latest Auto Work Status
                              </div>
                              <div className="text-[12px] font-bold text-[#5c493c] dark:text-[#f3eadf]">
                                {autoWorkState?.label || latestRun.status}
                              </div>
                            </div>
                            {canRetryLatestRun && (
                              <button
                                type="button"
                                onClick={handleRetryLatestRun}
                                disabled={isRetryingRun}
                                className="px-3 py-1.5 rounded-xl bg-[#3c829e] dark:bg-[#e0a070] text-white dark:text-[#292119] text-[10px] font-mono font-extrabold hover:bg-[#2e6d87] dark:hover:bg-[#d6b56d] transition-colors cursor-pointer disabled:opacity-60"
                              >
                                {isRetryingRun ? 'Retrying...' : 'Retry Run'}
                              </button>
                            )}
                          </div>
                          {latestRun.errorMessage && (
                            <div className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#d6b56d] break-words">
                              {latestRun.errorMessage}
                            </div>
                          )}
                          {autoWorkState?.message && autoWorkState.message !== latestRun.errorMessage && (
                            <div className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#d6b56d] break-words">
                              {autoWorkState.message}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-center py-4 text-[10px] font-mono text-[#a59182] dark:text-[#8a7a6a]">
                          No auto-work runs initiated for this task yet.
                        </div>
                      )}

                      <div className="bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl p-3 space-y-2 shadow-2xs">
                        <div className="text-[10px] font-mono uppercase tracking-widest text-[#8a6e5a] dark:text-[#f3eadf] font-extrabold">
                          Final Output
                        </div>
                        {latestRunLogLoading && (
                          <div className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#b8ab9f]">
                            Loading captured run log…
                          </div>
                        )}
                        {!latestRunLogLoading && latestRunLogError && (
                          <div className="text-[10px] font-mono text-[#b4432d] dark:text-[#f3eadf] break-words">
                            {latestRunLogError}
                          </div>
                        )}
                        {!latestRunLogLoading && !latestRunLogError && !latestRun && (
                          <div className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#b8ab9f]">
                            No run log yet.
                          </div>
                        )}
                        {!latestRunLogLoading && !latestRunLogError && latestRun && !latestRunLogExists && (
                          <div className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#b8ab9f]">
                            No captured run log yet.
                          </div>
                        )}
                        {!latestRunLogLoading && !latestRunLogError && latestRunLogExists && (
                          <pre className="max-h-64 overflow-auto rounded-xl bg-[#f7f3ea] dark:bg-[#14110d] p-3 text-[10px] font-mono leading-relaxed whitespace-pre-wrap break-words text-[#45372d] dark:text-[#f3eadf]">
                            {latestRunLogTail || '(empty log)'}
                          </pre>
                        )}
                      </div>

                      {runHistoryFiles && (
                        <div className="space-y-2">
                          <div className="text-[10px] font-mono uppercase tracking-widest text-[#8a6e5a] dark:text-[#f3eadf] font-extrabold px-1">
                            Run History Files
                          </div>
                          <div className="grid grid-cols-1 gap-2">
                            {[
                              ['Run Folder', runHistoryFiles.runDir],
                              ['Prompt', runHistoryFiles.promptPath],
                              ['Launch', runHistoryFiles.launchMetadataPath],
                              ['Summary', runHistoryFiles.outputSummaryPath],
                              ['Result', runHistoryFiles.resultPath],
                              ['Log', runHistoryFiles.logPath],
                            ].map(([label, pathValue]) => (
                              <button
                                key={label}
                                type="button"
                                onClick={() => {
                                  if (label === 'Log' && onShowLog && task.latestAgentRun) {
                                    onShowLog({ id: task.latestAgentRun.id, status: task.latestAgentRun.status, agent: task.agent, model: task.model });
                                  } else {
                                    handleCopyHistoryPath(pathValue);
                                  }
                                }}
                                className="w-full text-left bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 hover:bg-[#fffcf6] dark:hover:bg-[#1e1914] transition-colors cursor-pointer shadow-2xs group"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-[9px] font-mono uppercase text-[#8a6e5a] dark:text-[#d6b56d] font-extrabold">{label}</span>
                                  <span className={`text-[9px] font-mono font-bold ${label === 'Log' ? 'text-blue-500 dark:text-[#8ba4e8]' : 'text-emerald-600 dark:text-[#e0a070] opacity-0 group-hover:opacity-100 transition-opacity'}`}>
                                    {label === 'Log' ? 'view log' : copiedHistoryPath === pathValue ? 'copied' : 'copy path'}
                                  </span>
                                </div>
                                <div className="mt-1 text-[10px] font-mono text-[#5c493c] dark:text-[#f3eadf] break-all truncate">
                                  {pathValue}
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* HISTORY TAB */}
                  {activeLogTab === 'history' && (
                    <div className="space-y-0 relative before:absolute before:inset-0 before:left-[12px] before:h-full before:w-px before:bg-gradient-to-b before:from-transparent before:via-[#ebdcb9] dark:before:via-[#584a3b] before:to-transparent max-h-96 overflow-y-auto pr-1 scrollbar-thin">
                      {[...task.logs]
                        .filter(log => log.type !== 'comment')
                        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                        .map((log) => (
                          <div 
                            key={log.id} 
                            className="relative flex items-start gap-3 py-2"
                          >
                            <div className={`w-2 h-2 mt-1.5 rounded-full ring-4 ring-[#fdfbf7] dark:ring-[#292119]/50 shrink-0 z-10 ml-[8px] ${
                                log.type === 'create' ? 'bg-[#7dad71] dark:bg-[#a3c773]' :
                                log.type === 'move' ? 'bg-[#d89745] dark:bg-[#d6b56d]' :
                                'bg-[#8a6e5a] dark:bg-[#b8ab9f]'
                              }`} 
                            />
                            
                            <div className="flex-1 flex flex-col min-w-0 pr-2">
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-0.5">
                                <span className="text-[9px] font-mono font-bold uppercase tracking-widest text-[#5c493c] dark:text-[#f3eadf]">
                                  {log.type}
                                </span>
                                <span className="text-[8px] font-mono text-[#c4b3a4] dark:text-[#8a7a6a]">
                                  {new Date(log.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>
                              <p className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#b8ab9f] leading-snug break-words">
                                {log.message}
                              </p>
                            </div>
                          </div>
                        ))}
                      {task.logs.filter(l => l.type !== 'comment').length === 0 && (
                        <div className="text-center py-4 text-[10px] font-mono text-[#a59182] dark:text-[#8a7a6a]">
                          No system history available.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
    </>
  );
}
