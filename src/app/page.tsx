"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface JobSummary {
  id: string;
  searchType: "people" | "companies";
  status: "searching" | "enriching" | "paused" | "complete" | "error";
  totalEntries: number;
  enrichedCount: number;
  emailsFound: number;
  pausedUntil: number | null;
  remaining?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export default function Home() {
  const [apolloUrl, setApolloUrl] = useState("");
  const [searchType, setSearchType] = useState<"people" | "companies">("people");
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<JobSummary | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load jobs on mount ──────────────────────────

  const loadJobs = useCallback(async () => {
    try {
      const resp = await fetch("/api/jobs");
      if (resp.ok) {
        const data = await resp.json();
        setJobs(data.jobs || []);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // ── Poll active job ─────────────────────────────

  const pollJob = useCallback(async (jobId: string) => {
    try {
      const resp = await fetch(`/api/jobs?id=${jobId}`);
      if (!resp.ok) return;
      const job: JobSummary = await resp.json();
      setActiveJob(job);

      // If paused and pause has expired, trigger processing
      if (job.status === "paused" && job.pausedUntil && Date.now() >= job.pausedUntil) {
        fetch("/api/jobs/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        }).catch(() => {});
      }

      // Stop polling if done
      if (job.status === "complete" || job.status === "error") {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        loadJobs(); // Refresh job list
      }
    } catch {
      // ignore
    }
  }, [loadJobs]);

  const startPolling = useCallback((jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    setActiveJobId(jobId);
    pollJob(jobId); // immediate first poll
    pollRef.current = setInterval(() => pollJob(jobId), 5000);
  }, [pollJob]);

  // Auto-poll if there's an active (non-finished) job on load
  useEffect(() => {
    const active = jobs.find((j) => j.status === "enriching" || j.status === "paused" || j.status === "searching");
    if (active && !activeJobId) {
      startPolling(active.id);
    }
  }, [jobs, activeJobId, startPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // ── Start new job ───────────────────────────────

  const startExport = async () => {
    if (!apolloUrl.trim()) return;
    setStarting(true);
    setError("");

    try {
      const resp = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apolloUrl, searchType }),
      });

      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed to start job");

      if (data.status === "complete") {
        // Company search - done immediately
        await loadJobs();
        setActiveJobId(data.jobId);
        setActiveJob({
          id: data.jobId, searchType: "companies", status: "complete",
          totalEntries: data.totalEntries, enrichedCount: 0, emailsFound: 0,
          pausedUntil: null, createdAt: Date.now(), updatedAt: Date.now(),
        });
      } else {
        startPolling(data.jobId);
      }

      setApolloUrl("");
    } catch (err) {
      setError(String(err));
    } finally {
      setStarting(false);
    }
  };

  // ── Helpers ─────────────────────────────────────

  const formatTime = (ms: number) => {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const estimateTotal = (job: JobSummary) => {
    const remaining = job.remaining || (job.totalEntries - job.enrichedCount);
    if (remaining <= 0) return "";
    const batchesLeft = Math.ceil(remaining / 45);
    const secsLeft = batchesLeft * 20;
    const rateWaits = Math.floor(remaining / 380);
    const totalSecs = secsLeft + rateWaits * 62 * 60;
    if (totalSecs > 3600) return `~${(totalSecs / 3600).toFixed(1)}h remaining`;
    return `~${Math.round(totalSecs / 60)}min remaining`;
  };

  const statusColor = (s: string) => {
    switch (s) {
      case "complete": return "#22c55e";
      case "error": return "#ef4444";
      case "paused": return "#f59e0b";
      default: return "#6366f1";
    }
  };

  // ── Render ──────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col bg-[#09090b] text-[#fafafa]">
      <header className="border-b border-[#27272a] px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#6366f1] flex items-center justify-center text-white font-bold text-sm">A</div>
          <div>
            <h1 className="text-lg font-semibold">Apollo Export Tool</h1>
            <p className="text-xs text-[#71717a]">Runs on the server - close your laptop, come back later</p>
          </div>
        </div>
      </header>

      <main className="flex-1 px-6 py-8">
        <div className="max-w-5xl mx-auto space-y-8">
          {/* New Export */}
          <section className="space-y-4">
            <h2 className="text-sm font-medium text-[#a1a1aa] uppercase tracking-wider">New Export</h2>
            <div className="flex gap-3 items-start">
              <div className="flex-1 space-y-3">
                <div className="flex gap-2 items-center">
                  <div className="flex gap-1 p-1 bg-[#18181b] rounded-lg">
                    <button
                      onClick={() => setSearchType("people")}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        searchType === "people" ? "bg-[#6366f1] text-white" : "text-[#71717a] hover:text-white"
                      }`}
                    >
                      People
                    </button>
                    <button
                      onClick={() => setSearchType("companies")}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        searchType === "companies" ? "bg-[#6366f1] text-white" : "text-[#71717a] hover:text-white"
                      }`}
                    >
                      Companies
                    </button>
                  </div>
                </div>
                <textarea
                  value={apolloUrl}
                  onChange={(e) => {
                    const url = e.target.value;
                    setApolloUrl(url);
                    if (url.includes("/companies")) setSearchType("companies");
                    else if (url.includes("/people")) setSearchType("people");
                  }}
                  placeholder="Paste Apollo.io search URL..."
                  rows={2}
                  className="w-full px-3 py-2 bg-[#18181b] border border-[#27272a] rounded-lg text-xs font-mono placeholder:text-[#52525b] focus:outline-none focus:border-[#6366f1] transition-colors resize-none"
                />
              </div>
              <button
                onClick={startExport}
                disabled={!apolloUrl.trim() || starting}
                className="px-6 py-2.5 bg-[#6366f1] text-white rounded-lg text-sm font-medium hover:bg-[#818cf8] transition-colors disabled:opacity-30 disabled:cursor-not-allowed mt-9 shrink-0"
              >
                {starting ? "Starting..." : "Start Export"}
              </button>
            </div>
            {error && (
              <div className="p-3 bg-[#ef4444]/5 border border-[#ef4444]/20 rounded-lg text-[#ef4444] text-sm">{error}</div>
            )}
          </section>

          {/* Active Job */}
          {activeJob && (
            <section className="space-y-4">
              <h2 className="text-sm font-medium text-[#a1a1aa] uppercase tracking-wider">
                Active Job
                <span className="ml-2 inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: statusColor(activeJob.status) }} />
                  <span className="normal-case font-normal" style={{ color: statusColor(activeJob.status) }}>{activeJob.status}</span>
                </span>
              </h2>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard label="Total Found" value={activeJob.totalEntries.toLocaleString()} sub={activeJob.searchType} />
                {activeJob.searchType === "people" && (
                  <>
                    <StatCard
                      label="Enriched"
                      value={activeJob.enrichedCount.toLocaleString()}
                      sub={activeJob.totalEntries > 0 ? `${Math.round((activeJob.enrichedCount / activeJob.totalEntries) * 100)}%` : ""}
                    />
                    <StatCard
                      label="Emails Found"
                      value={activeJob.emailsFound.toLocaleString()}
                      sub={activeJob.enrichedCount > 0 ? `${Math.round((activeJob.emailsFound / activeJob.enrichedCount) * 100)}% hit rate` : ""}
                    />
                    <StatCard
                      label={activeJob.status === "paused" ? "Resumes in" : "ETA"}
                      value={
                        activeJob.status === "paused" && activeJob.pausedUntil
                          ? formatTime(activeJob.pausedUntil - Date.now())
                          : activeJob.status === "complete"
                          ? "Done"
                          : estimateTotal(activeJob) || "Calculating..."
                      }
                      sub={activeJob.status === "paused" ? "rate limited - server will auto-resume" : ""}
                    />
                  </>
                )}
              </div>

              {/* Progress bar */}
              {activeJob.searchType === "people" && activeJob.totalEntries > 0 && (
                <div className="space-y-1">
                  <div className="w-full h-1.5 bg-[#27272a] rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.round((activeJob.enrichedCount / activeJob.totalEntries) * 100)}%`,
                        backgroundColor: statusColor(activeJob.status),
                      }}
                    />
                  </div>
                </div>
              )}

              {activeJob.status === "complete" && (
                <a
                  href={`/api/jobs?id=${activeJob.id}&action=csv`}
                  className="inline-flex px-6 py-2.5 bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/20 rounded-lg text-sm font-medium hover:bg-[#22c55e]/20 transition-colors"
                >
                  Download CSV ({activeJob.totalEntries.toLocaleString()} records)
                </a>
              )}
            </section>
          )}

          {/* Job History */}
          {jobs.length > 0 && (
            <section className="space-y-4">
              <h2 className="text-sm font-medium text-[#a1a1aa] uppercase tracking-wider">All Jobs</h2>
              <div className="bg-[#18181b] border border-[#27272a] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#27272a] text-[#71717a] text-xs">
                      <th className="px-4 py-2 text-left font-medium">Type</th>
                      <th className="px-4 py-2 text-left font-medium">Status</th>
                      <th className="px-4 py-2 text-left font-medium">Total</th>
                      <th className="px-4 py-2 text-left font-medium">Enriched</th>
                      <th className="px-4 py-2 text-left font-medium">Emails</th>
                      <th className="px-4 py-2 text-left font-medium">Started</th>
                      <th className="px-4 py-2 text-left font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((job) => (
                      <tr key={job.id} className="border-b border-[#27272a]/50">
                        <td className="px-4 py-2 capitalize">{job.searchType}</td>
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: statusColor(job.status) }} />
                            <span style={{ color: statusColor(job.status) }}>{job.status}</span>
                          </span>
                        </td>
                        <td className="px-4 py-2">{job.totalEntries.toLocaleString()}</td>
                        <td className="px-4 py-2">{job.enrichedCount.toLocaleString()}</td>
                        <td className="px-4 py-2">{job.emailsFound.toLocaleString()}</td>
                        <td className="px-4 py-2 text-[#71717a]">{new Date(job.createdAt).toLocaleString()}</td>
                        <td className="px-4 py-2">
                          <div className="flex gap-2">
                            {(job.status === "complete" || job.enrichedCount > 0) && (
                              <a
                                href={`/api/jobs?id=${job.id}&action=csv`}
                                className="text-xs text-[#22c55e] hover:underline"
                              >
                                CSV
                              </a>
                            )}
                            {(job.status === "enriching" || job.status === "paused") && activeJobId !== job.id && (
                              <button
                                onClick={() => startPolling(job.id)}
                                className="text-xs text-[#6366f1] hover:underline"
                              >
                                Monitor
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </main>

      <footer className="border-t border-[#27272a] px-6 py-3 text-center text-[11px] text-[#52525b]">
        Apollo Export Tool &middot; Server-side processing &middot; 400 enrichments/hour (auto-pauses and resumes)
      </footer>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-[#18181b] border border-[#27272a] rounded-lg p-3">
      <div className="text-[11px] text-[#71717a] uppercase tracking-wider">{label}</div>
      <div className="text-xl font-semibold mt-0.5">{value}</div>
      {sub && <div className="text-xs text-[#71717a] mt-0.5">{sub}</div>}
    </div>
  );
}
