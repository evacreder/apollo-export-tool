"use client";

import { useState, useRef, useCallback, useEffect } from "react";

type SearchType = "people" | "companies";
type JobStatus = "idle" | "searching" | "enriching" | "paused" | "complete" | "error";

interface SearchPerson {
  id: string;
  first_name: string;
  last_name_obfuscated: string;
  title: string;
  company: string;
  has_email: boolean;
}

interface EnrichedPerson {
  first_name: string;
  last_name: string;
  email: string;
  personal_email: string;
  title: string;
  company: string;
  company_domain: string;
  city: string;
  state: string;
  country: string;
  location: string;
  linkedin_url: string;
  website: string;
  employees: string;
  industry: string;
  phone: string;
  seniority: string;
  departments: string;
}

interface CompanyResult {
  name: string;
  domain: string;
  website: string;
  industry: string;
  employees: string;
  revenue: string;
  city: string;
  state: string;
  country: string;
  location: string;
  linkedin_url: string;
  phone: string;
  founded_year: string;
  description: string;
  latest_funding_stage: string;
  keywords: string;
}

export default function Home() {
  const [searchType, setSearchType] = useState<SearchType>("people");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [apolloUrl, setApolloUrl] = useState("");
  const [status, setStatus] = useState<JobStatus>("idle");
  const [error, setError] = useState("");

  // Search state
  const [searchedPeople, setSearchedPeople] = useState<SearchPerson[]>([]);
  const [searchedCompanies, setSearchedCompanies] = useState<CompanyResult[]>([]);
  const [totalEntries, setTotalEntries] = useState(0);
  const [searchPage, setSearchPage] = useState(0);
  const [searchTotalPages, setSearchTotalPages] = useState(0);

  // Enrichment state (people only)
  const [enrichedPeople, setEnrichedPeople] = useState<Record<string, EnrichedPerson | null>>({});
  const [enrichedCount, setEnrichedCount] = useState(0);
  const [enrichBatchNum, setEnrichBatchNum] = useState(0);

  // Rate limit state
  const [rateLimitCountdown, setRateLimitCountdown] = useState(0);
  const [pausedAt, setPausedAt] = useState<Date | null>(null);

  // Log
  const [logs, setLogs] = useState<string[]>([]);
  const cancelRef = useRef(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const log = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-300), `[${ts}] ${msg}`]);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Countdown timer for rate limit
  useEffect(() => {
    if (rateLimitCountdown <= 0) return;
    const timer = setInterval(() => {
      setRateLimitCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [rateLimitCountdown]);

  // Auto-resume after rate limit countdown
  useEffect(() => {
    if (rateLimitCountdown === 0 && status === "paused") {
      log("Rate limit reset. Resuming enrichment...");
      resumeEnrichment();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rateLimitCountdown, status]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // ── SEARCH ──────────────────────────────────────

  const startExport = async () => {
    cancelRef.current = false;
    setStatus("searching");
    setError("");
    setSearchedPeople([]);
    setSearchedCompanies([]);
    setEnrichedPeople({});
    setEnrichedCount(0);
    setEnrichBatchNum(0);
    setTotalEntries(0);
    setSearchPage(0);
    setSearchTotalPages(0);
    setLogs([]);

    log(`Starting ${searchType} search...`);

    try {
      let page = 1;
      let total = 0;
      let allPeople: SearchPerson[] = [];
      let allCompanies: CompanyResult[] = [];

      // First page
      const firstResp = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, apolloUrl, type: searchType, page }),
      });

      if (!firstResp.ok) {
        const err = await firstResp.json();
        throw new Error(err.error || `Search failed: ${firstResp.status}`);
      }

      const firstData = await firstResp.json();

      if (searchType === "people") {
        total = firstData.totalEntries;
        allPeople = firstData.people;
        setSearchedPeople(allPeople);
      } else {
        total = firstData.totalEntries;
        allCompanies = firstData.companies;
        setSearchedCompanies(allCompanies);
      }

      setTotalEntries(total);
      const perPage = searchType === "people" ? firstData.people.length : firstData.companies.length;
      const totalPages = perPage > 0 ? Math.ceil(total / perPage) : 0;
      setSearchTotalPages(totalPages);
      setSearchPage(1);
      log(`Found ${total.toLocaleString()} ${searchType}. ${totalPages} pages to fetch.`);

      // Remaining pages
      while (page < totalPages && !cancelRef.current) {
        page++;
        const resp = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey, apolloUrl, type: searchType, page }),
        });

        if (!resp.ok) {
          log(`Warning: search page ${page} failed, continuing...`);
          continue;
        }

        const data = await resp.json();

        if (searchType === "people") {
          allPeople = [...allPeople, ...data.people];
          setSearchedPeople(allPeople);
        } else {
          allCompanies = [...allCompanies, ...data.companies];
          setSearchedCompanies(allCompanies);
        }

        setSearchPage(page);
        log(`Page ${page}/${totalPages} (${searchType === "people" ? allPeople.length : allCompanies.length} total)`);
      }

      if (cancelRef.current) {
        setStatus("idle");
        log("Cancelled.");
        return;
      }

      // For companies, we're done - no enrichment needed
      if (searchType === "companies") {
        setStatus("complete");
        log(`Search complete! ${allCompanies.length} companies ready to download.`);
        return;
      }

      // For people, start enrichment
      log(`Search complete. Starting enrichment of ${allPeople.length} contacts...`);
      setStatus("enriching");
      await enrichBatch(allPeople, {});
    } catch (err) {
      setError(String(err));
      setStatus("error");
      log(`Error: ${err}`);
    }
  };

  // ── ENRICH ──────────────────────────────────────

  const enrichBatch = async (
    people: SearchPerson[],
    existing: Record<string, EnrichedPerson | null>
  ) => {
    const toEnrich = people.filter((p) => p.id && !(p.id in existing));
    if (toEnrich.length === 0) {
      setStatus("complete");
      log("All contacts enriched!");
      return;
    }

    let enriched = { ...existing };
    let count = Object.keys(existing).filter((k) => existing[k] !== null).length;
    const BATCH_SIZE = 50;
    let batchNum = Math.floor(count / BATCH_SIZE);

    for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
      if (cancelRef.current) {
        setStatus("idle");
        log("Cancelled.");
        return;
      }

      const batch = toEnrich.slice(i, i + BATCH_SIZE);
      const ids = batch.map((p) => p.id);
      batchNum++;
      setEnrichBatchNum(batchNum);

      log(`Enriching batch ${batchNum} (${ids.length} contacts)...`);

      const resp = await fetch("/api/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, personIds: ids }),
      });

      if (!resp.ok) {
        log(`Batch ${batchNum} failed: ${resp.status}`);
        continue;
      }

      const data = await resp.json();

      // Merge results
      enriched = { ...enriched, ...data.results };
      count += data.enrichedCount;
      setEnrichedPeople(enriched);
      setEnrichedCount(count);

      const emailsInBatch = Object.values(data.results).filter(
        (p: unknown) => p && (p as EnrichedPerson).email
      ).length;
      log(`Batch ${batchNum}: ${data.enrichedCount} enriched, ${emailsInBatch} emails found`);

      // Rate limited
      if (data.rateLimited) {
        const waitSeconds = 62 * 60; // 62 minutes
        setRateLimitCountdown(waitSeconds);
        setPausedAt(new Date());
        setStatus("paused");
        const remaining = toEnrich.length - i - data.enrichedCount;
        log(`Rate limited! ${remaining} contacts remaining. Auto-resuming in ~62 minutes...`);
        return; // Will auto-resume via useEffect
      }
    }

    setStatus("complete");
    const totalEmails = Object.values(enriched).filter(
      (p) => p && p.email
    ).length;
    log(`Enrichment complete! ${count} contacts enriched, ${totalEmails} emails found.`);
  };

  const resumeEnrichment = async () => {
    setStatus("enriching");
    setPausedAt(null);
    await enrichBatch(searchedPeople, enrichedPeople);
  };

  // ── CSV DOWNLOAD ────────────────────────────────

  const downloadCSV = () => {
    let csv = "";

    if (searchType === "companies") {
      const headers = [
        "name", "domain", "website", "industry", "employees", "revenue",
        "city", "state", "country", "location", "linkedin_url", "phone",
        "founded_year", "description", "latest_funding_stage", "keywords",
      ];
      const rows = searchedCompanies.map((c) =>
        headers.map((h) => esc(c[h as keyof CompanyResult])).join(",")
      );
      csv = [headers.join(","), ...rows].join("\n");
    } else {
      const headers = [
        "first_name", "last_name", "email", "personal_email", "title",
        "company", "company_domain", "location", "city", "state", "country",
        "linkedin_url", "website", "employees", "industry", "phone",
        "seniority", "departments",
      ];

      const rows = searchedPeople.map((sp) => {
        const e = enrichedPeople[sp.id];
        if (e) {
          return headers.map((h) => esc(e[h as keyof EnrichedPerson])).join(",");
        }
        // Fallback for unenriched
        return [
          esc(sp.first_name), esc(sp.last_name_obfuscated), "", "", esc(sp.title),
          esc(sp.company), "", "", "", "", "", "", "", "", "", "", "", "",
        ].join(",");
      });
      csv = [headers.join(","), ...rows].join("\n");
    }

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `apollo_${searchType}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const cancel = () => {
    cancelRef.current = true;
    setStatus("idle");
    log("Cancelling...");
  };

  // ── DERIVED STATE ───────────────────────────────

  const isRunning = status === "searching" || status === "enriching";
  const canDownload =
    (searchType === "companies" && searchedCompanies.length > 0) ||
    (searchType === "people" && Object.keys(enrichedPeople).length > 0);

  const totalEmailsFound = Object.values(enrichedPeople).filter(
    (p) => p && p.email
  ).length;

  const enrichPct =
    searchedPeople.length > 0
      ? Math.round((Object.keys(enrichedPeople).length / searchedPeople.length) * 100)
      : 0;

  const searchPct =
    searchTotalPages > 0 ? Math.round((searchPage / searchTotalPages) * 100) : 0;

  const estimateTimeRemaining = () => {
    if (status !== "enriching" || enrichedCount === 0) return "";
    const remaining = searchedPeople.length - Object.keys(enrichedPeople).length;
    if (remaining <= 0) return "";
    // ~25s per batch of 50, plus possible rate limit waits
    const batchesLeft = Math.ceil(remaining / 50);
    const secsLeft = batchesLeft * 25;
    const rateWaits = Math.floor(remaining / 380);
    const totalSecs = secsLeft + rateWaits * 62 * 60;
    if (totalSecs > 3600) {
      const hrs = Math.round(totalSecs / 3600 * 10) / 10;
      return `~${hrs}h remaining`;
    }
    return `~${Math.round(totalSecs / 60)}min remaining`;
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#09090b] text-[#fafafa]">
      {/* Header */}
      <header className="border-b border-[#27272a] px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#6366f1] flex items-center justify-center text-white font-bold text-sm">
              A
            </div>
            <div>
              <h1 className="text-lg font-semibold">Apollo Export Tool</h1>
              <p className="text-xs text-[#71717a]">Search to CSV with auto rate-limit handling</p>
            </div>
          </div>
          {isRunning && (
            <div className="flex items-center gap-2 text-xs text-[#71717a]">
              <span className="w-2 h-2 rounded-full bg-[#22c55e] animate-pulse" />
              Running
            </div>
          )}
          {status === "paused" && (
            <div className="flex items-center gap-2 text-xs text-[#f59e0b]">
              <span className="w-2 h-2 rounded-full bg-[#f59e0b] animate-pulse" />
              Paused - Rate limited
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 px-6 py-8">
        <div className="max-w-5xl mx-auto space-y-6">
          {/* Controls Row */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4">
            {/* Left: Inputs */}
            <div className="space-y-4">
              {/* Type toggle + API Key */}
              <div className="flex gap-3 items-center">
                <div className="flex gap-1 p-1 bg-[#18181b] rounded-lg shrink-0">
                  <button
                    onClick={() => setSearchType("people")}
                    disabled={isRunning}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      searchType === "people" ? "bg-[#6366f1] text-white" : "text-[#71717a] hover:text-white"
                    }`}
                  >
                    People Search
                  </button>
                  <button
                    onClick={() => setSearchType("companies")}
                    disabled={isRunning}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      searchType === "companies" ? "bg-[#6366f1] text-white" : "text-[#71717a] hover:text-white"
                    }`}
                  >
                    Company Search
                  </button>
                </div>
                <button
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="text-[11px] text-[#52525b] hover:text-[#71717a] transition-colors shrink-0"
                >
                  {showApiKey ? "Hide Settings" : "Settings"}
                </button>
                {!showApiKey && !apiKey && (
                  <span className="text-[11px] text-[#22c55e]/60">Using team key</span>
                )}
              </div>
              {showApiKey && (
                <div className="space-y-1">
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Leave blank to use team default"
                    disabled={isRunning}
                    className="w-full px-3 py-2 bg-[#18181b] border border-[#27272a] rounded-lg text-sm font-mono placeholder:text-[#52525b] focus:outline-none focus:border-[#6366f1] transition-colors"
                  />
                  <p className="text-[10px] text-[#52525b]">Optional. Leave blank to use the pre-configured team API key.</p>
                </div>
              )}
              {/* URL Input */}
              <textarea
                value={apolloUrl}
                onChange={(e) => {
                  const url = e.target.value;
                  setApolloUrl(url);
                  // Auto-detect search type from URL
                  if (url.includes("/companies") || url.includes("/organizations")) {
                    setSearchType("companies");
                  } else if (url.includes("/people")) {
                    setSearchType("people");
                  }
                }}
                placeholder="Paste any Apollo.io search URL here (people or company)..."
                rows={2}
                disabled={isRunning}
                className="w-full px-3 py-2 bg-[#18181b] border border-[#27272a] rounded-lg text-xs font-mono placeholder:text-[#52525b] focus:outline-none focus:border-[#6366f1] transition-colors resize-none"
              />
            </div>

            {/* Right: Actions */}
            <div className="flex flex-col gap-2 md:w-48">
              {isRunning || status === "paused" ? (
                <button
                  onClick={cancel}
                  className="w-full px-4 py-2.5 bg-[#ef4444]/10 text-[#ef4444] border border-[#ef4444]/20 rounded-lg text-sm font-medium hover:bg-[#ef4444]/20 transition-colors"
                >
                  Cancel
                </button>
              ) : (
                <button
                  onClick={startExport}
                  disabled={!apolloUrl.trim()}
                  className="w-full px-4 py-2.5 bg-[#6366f1] text-white rounded-lg text-sm font-medium hover:bg-[#818cf8] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Start Export
                </button>
              )}
              {canDownload && (
                <button
                  onClick={downloadCSV}
                  className="w-full px-4 py-2.5 bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/20 rounded-lg text-sm font-medium hover:bg-[#22c55e]/20 transition-colors"
                >
                  Download CSV
                </button>
              )}
            </div>
          </div>

          {/* Stats Cards */}
          {(status !== "idle" || totalEntries > 0) && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                label="Total Found"
                value={totalEntries.toLocaleString()}
                sub={searchType}
              />
              {searchType === "people" && (
                <>
                  <StatCard
                    label="Enriched"
                    value={Object.keys(enrichedPeople).length.toLocaleString()}
                    sub={`${enrichPct}%`}
                  />
                  <StatCard
                    label="Emails Found"
                    value={totalEmailsFound.toLocaleString()}
                    sub={
                      Object.keys(enrichedPeople).length > 0
                        ? `${Math.round((totalEmailsFound / Object.keys(enrichedPeople).length) * 100)}% hit rate`
                        : ""
                    }
                  />
                  <StatCard
                    label="Status"
                    value={
                      status === "paused"
                        ? formatTime(rateLimitCountdown)
                        : status === "complete"
                        ? "Done"
                        : status === "enriching"
                        ? `Batch ${enrichBatchNum}`
                        : status === "searching"
                        ? `Page ${searchPage}/${searchTotalPages}`
                        : "Ready"
                    }
                    sub={
                      status === "paused"
                        ? "until resume"
                        : status === "enriching"
                        ? estimateTimeRemaining()
                        : ""
                    }
                  />
                </>
              )}
              {searchType === "companies" && (
                <StatCard
                  label="Status"
                  value={
                    status === "complete"
                      ? "Done"
                      : status === "searching"
                      ? `Page ${searchPage}/${searchTotalPages}`
                      : "Ready"
                  }
                  sub={`${searchedCompanies.length} fetched`}
                />
              )}
            </div>
          )}

          {/* Progress Bars */}
          {status === "searching" && (
            <ProgressBar label="Searching..." pct={searchPct} color="#6366f1" />
          )}
          {(status === "enriching" || status === "paused") && searchType === "people" && (
            <ProgressBar
              label={status === "paused" ? `Paused (resumes in ${formatTime(rateLimitCountdown)})` : "Enriching..."}
              pct={enrichPct}
              color={status === "paused" ? "#f59e0b" : "#22c55e"}
            />
          )}

          {/* Error */}
          {error && (
            <div className="p-3 bg-[#ef4444]/5 border border-[#ef4444]/20 rounded-lg text-[#ef4444] text-sm">
              {error}
            </div>
          )}

          {/* Complete Banner */}
          {status === "complete" && (
            <div className="p-3 bg-[#22c55e]/5 border border-[#22c55e]/20 rounded-lg text-[#22c55e] text-sm font-medium">
              Export complete! Click &quot;Download CSV&quot; to save your file.
              {searchType === "people" && ` ${totalEmailsFound} emails found out of ${Object.keys(enrichedPeople).length} contacts.`}
            </div>
          )}

          {/* Activity Log */}
          {logs.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-[#71717a] uppercase tracking-wider">Activity Log</h3>
              <div className="bg-[#18181b] border border-[#27272a] rounded-lg p-3 h-52 overflow-y-auto font-mono text-[11px] leading-relaxed">
                {logs.map((entry, i) => (
                  <div key={i} className="text-[#71717a]">
                    {entry}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}

          {/* Preview Table */}
          {canDownload && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-[#71717a] uppercase tracking-wider">
                Preview (first 15 rows)
              </h3>
              <div className="bg-[#18181b] border border-[#27272a] rounded-lg overflow-x-auto">
                {searchType === "people" ? (
                  <PeoplePreview people={searchedPeople} enriched={enrichedPeople} />
                ) : (
                  <CompanyPreview companies={searchedCompanies} />
                )}
              </div>
            </div>
          )}
        </div>
      </main>

      <footer className="border-t border-[#27272a] px-6 py-3 text-center text-[11px] text-[#52525b]">
        Apollo Export Tool &middot; Rate limit: 400 enrichments/hour (auto-pauses and resumes)
      </footer>
    </div>
  );
}

// ── COMPONENTS ──────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-[#18181b] border border-[#27272a] rounded-lg p-3">
      <div className="text-[11px] text-[#71717a] uppercase tracking-wider">{label}</div>
      <div className="text-xl font-semibold mt-0.5">{value}</div>
      {sub && <div className="text-xs text-[#71717a] mt-0.5">{sub}</div>}
    </div>
  );
}

function ProgressBar({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-[#71717a]">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="w-full h-1.5 bg-[#27272a] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function PeoplePreview({
  people,
  enriched,
}: {
  people: SearchPerson[];
  enriched: Record<string, EnrichedPerson | null>;
}) {
  const preview = people.slice(0, 15);
  return (
    <table className="w-full text-[11px]">
      <thead>
        <tr className="border-b border-[#27272a] text-[#71717a]">
          <th className="px-2 py-1.5 text-left font-medium">Name</th>
          <th className="px-2 py-1.5 text-left font-medium">Email</th>
          <th className="px-2 py-1.5 text-left font-medium">Title</th>
          <th className="px-2 py-1.5 text-left font-medium">Company</th>
          <th className="px-2 py-1.5 text-left font-medium">Location</th>
        </tr>
      </thead>
      <tbody>
        {preview.map((sp) => {
          const e = enriched[sp.id];
          return (
            <tr key={sp.id} className="border-b border-[#27272a]/50">
              <td className="px-2 py-1.5 whitespace-nowrap">
                {e ? `${e.first_name} ${e.last_name}` : `${sp.first_name} ${sp.last_name_obfuscated}`}
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                {e?.email ? (
                  <span className="text-[#22c55e]">{e.email}</span>
                ) : (
                  <span className="text-[#52525b]">--</span>
                )}
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap max-w-[150px] truncate">{e?.title || sp.title}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">{e?.company || sp.company}</td>
              <td className="px-2 py-1.5 whitespace-nowrap max-w-[150px] truncate">{e?.location || ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CompanyPreview({ companies }: { companies: CompanyResult[] }) {
  const preview = companies.slice(0, 15);
  return (
    <table className="w-full text-[11px]">
      <thead>
        <tr className="border-b border-[#27272a] text-[#71717a]">
          <th className="px-2 py-1.5 text-left font-medium">Name</th>
          <th className="px-2 py-1.5 text-left font-medium">Domain</th>
          <th className="px-2 py-1.5 text-left font-medium">Industry</th>
          <th className="px-2 py-1.5 text-left font-medium">Employees</th>
          <th className="px-2 py-1.5 text-left font-medium">Location</th>
        </tr>
      </thead>
      <tbody>
        {preview.map((c, i) => (
          <tr key={i} className="border-b border-[#27272a]/50">
            <td className="px-2 py-1.5 whitespace-nowrap">{c.name}</td>
            <td className="px-2 py-1.5 whitespace-nowrap text-[#6366f1]">{c.domain}</td>
            <td className="px-2 py-1.5 whitespace-nowrap max-w-[150px] truncate">{c.industry}</td>
            <td className="px-2 py-1.5 whitespace-nowrap">{c.employees}</td>
            <td className="px-2 py-1.5 whitespace-nowrap max-w-[150px] truncate">{c.location}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function esc(val: string): string {
  if (!val) return "";
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}
