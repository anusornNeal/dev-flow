import React, { useEffect, useState } from 'react';
import { X, RefreshCw, Activity, AlertCircle, Clock } from 'lucide-react';

interface ObservabilityModalProps {
  onClose: () => void;
}

export default function ObservabilityModal({ onClose }: ObservabilityModalProps) {
  const [metrics, setMetrics] = useState<any>(null);
  const [monitorSummary, setMonitorSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const [metricsRes, summaryRes] = await Promise.all([
        fetch('/api/tool-jobs-metrics').then(res => res.json()),
        fetch('/api/tool-monitor/summary').then(res => res.json())
      ]);
      setMetrics(metricsRes);
      setMonitorSummary(summaryRes);
    } catch (err: any) {
      setError(err.message || 'Failed to load observability data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="fixed inset-0 bg-[#3c2a1a]/60 dark:bg-[#110e0c]/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-white dark:bg-[#1e1914] rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl border border-[#ebdcb9] dark:border-[#584a3b] overflow-hidden">
        
        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b border-[#ebdcb9] dark:border-[#584a3b] bg-[#faf7f0] dark:bg-[#292119]">
          <h2 className="text-sm font-bold text-[#3c2a1a] dark:text-[#f3eadf] flex items-center gap-2">
            <Activity className="text-[#a46c24] dark:text-[#d6b56d]" size={16} />
            MCP & Agent Observability
          </h2>
          <div className="flex items-center gap-2">
            <button 
              onClick={fetchStats}
              className="p-1.5 text-[#a46c24] dark:text-[#d6b56d] hover:bg-[#ebdcb9] dark:hover:bg-[#584a3b]/50 rounded-xl transition-colors"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-[#a46c24] dark:text-[#d6b56d] hover:bg-[#ebdcb9] dark:hover:bg-[#584a3b]/50 rounded-xl transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6 text-[#3c2a1a] dark:text-[#f3eadf] text-xs font-mono">
          {error && (
            <div className="p-3 bg-red-50 text-red-600 rounded-xl border border-red-200">
              {error}
            </div>
          )}

          {metrics && (
            <>
              {/* Job Metrics */}
              <div>
                <h3 className="font-bold mb-3 flex items-center gap-2 uppercase tracking-wider text-[10px] text-[#816b5a]">
                  <Activity size={12} /> Job Metrics & Locks
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-4 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] bg-[#fffcf5] dark:bg-[#292119]">
                    <div className="text-[10px] uppercase text-[#816b5a] mb-1">Queue Depth</div>
                    <div className="text-xl font-bold">{metrics.queueDepth}</div>
                  </div>
                  <div className="p-4 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] bg-[#fffcf5] dark:bg-[#292119]">
                    <div className="text-[10px] uppercase text-[#816b5a] mb-1">Active Jobs</div>
                    <div className="text-xl font-bold">{metrics.activeJobs.length}</div>
                  </div>
                  <div className="p-4 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] bg-[#fffcf5] dark:bg-[#292119]">
                    <div className="text-[10px] uppercase text-[#816b5a] mb-1">Active Locks</div>
                    <div className="text-xl font-bold">{Object.keys(metrics.activeResources).length}</div>
                  </div>
                </div>
              </div>

              {/* Active Jobs & Locks */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] bg-[#fffcf5] dark:bg-[#292119]">
                  <h4 className="font-bold text-[10px] uppercase text-[#816b5a] mb-2">Active Jobs</h4>
                  {metrics.activeJobs.length === 0 ? (
                    <div className="opacity-50">No active jobs</div>
                  ) : (
                    <div className="space-y-2">
                      {metrics.activeJobs.map((j: any) => (
                        <div key={j.jobId} className="p-2 bg-black/5 dark:bg-white/5 rounded flex flex-col gap-1">
                          <div className="font-bold">{j.toolName}</div>
                          <div className="opacity-70 text-[10px]">{j.jobId} - {j.resourceKey}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="p-4 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] bg-[#fffcf5] dark:bg-[#292119]">
                  <h4 className="font-bold text-[10px] uppercase text-[#816b5a] mb-2">Active Locks</h4>
                  {Object.keys(metrics.activeResources).length === 0 ? (
                    <div className="opacity-50">No active locks</div>
                  ) : (
                    <div className="space-y-2">
                      {Object.entries(metrics.activeResources).map(([key, val]) => (
                        <div key={key} className="p-2 bg-black/5 dark:bg-white/5 rounded flex justify-between">
                          <span className="truncate pr-2">{key}</span>
                          <span className="font-bold">{val as any}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Recent Failures / Jobs */}
              <div className="p-4 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] bg-[#fffcf5] dark:bg-[#292119]">
                <h4 className="font-bold text-[10px] uppercase text-[#816b5a] mb-2">Recent MCP Jobs</h4>
                {metrics.recentJobs?.length === 0 ? (
                  <div className="opacity-50">No recent jobs</div>
                ) : (
                  <div className="space-y-2 max-h-[150px] overflow-y-auto">
                    {metrics.recentJobs?.slice(0, 10).map((j: any) => (
                      <div key={j.jobId} className="p-2 bg-black/5 dark:bg-white/5 rounded flex justify-between items-center">
                        <div>
                          <div className="font-bold">{j.toolName}</div>
                          <div className="opacity-70 text-[10px]">{new Date(j.createdAt).toLocaleTimeString()}</div>
                        </div>
                        <span className={px-2 py-1 rounded text-[10px] font-bold }>
                          {j.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {monitorSummary && (
            <>
              {/* Agent Monitor */}
              <div>
                <h3 className="font-bold mb-3 flex items-center gap-2 uppercase tracking-wider text-[10px] text-[#816b5a] mt-2">
                  <Activity size={12} /> Agent Run Metrics
                </h3>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-4 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] bg-[#fffcf5] dark:bg-[#292119]">
                    <h4 className="font-bold text-[10px] uppercase text-[#816b5a] mb-2 text-red-600 flex items-center gap-1">
                      <AlertCircle size={10} /> Duplicate / Burst Calls
                    </h4>
                    {monitorSummary.duplicateBursts?.length === 0 ? (
                      <div className="opacity-50 text-[#3c2a1a] dark:text-[#f3eadf]">No duplicate bursts detected.</div>
                    ) : (
                      <div className="space-y-2 max-h-[150px] overflow-y-auto">
                        {monitorSummary.duplicateBursts?.map((d: any, idx: number) => (
                          <div key={idx} className="p-2 bg-black/5 dark:bg-white/5 rounded">
                            <div className="font-bold">{d.toolName} <span className="text-red-500">x{d.count}</span></div>
                            <div className="opacity-70 text-[10px]">Hash: {d.inputHash}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="p-4 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] bg-[#fffcf5] dark:bg-[#292119]">
                    <h4 className="font-bold text-[10px] uppercase text-[#816b5a] mb-2 flex items-center gap-1">
                      <Clock size={10} /> Top Tools
                    </h4>
                    {monitorSummary.topTools?.length === 0 ? (
                      <div className="opacity-50">No tools used recently.</div>
                    ) : (
                      <div className="space-y-2 max-h-[150px] overflow-y-auto">
                        {monitorSummary.topTools?.slice(0, 5).map((t: any, idx: number) => (
                          <div key={idx} className="p-2 bg-black/5 dark:bg-white/5 rounded flex justify-between">
                            <div className="font-bold">{t.toolName}</div>
                            <div className="opacity-70">{t.count} calls ({t.avgDurationMs}ms avg)</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}
