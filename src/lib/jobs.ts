import { put, list, del, head } from "@vercel/blob";

// ── Job Types ─────────────────────────────────────

export interface Job {
  id: string;
  searchType: "people" | "companies";
  apolloUrl: string;
  status: "searching" | "enriching" | "paused" | "complete" | "error";
  totalEntries: number;
  searchedPeopleIds: string[]; // just IDs to save space
  searchedPeopleData: Record<string, { first_name: string; last_name_obfuscated: string; title: string; company: string }>;
  enrichedPeople: Record<string, EnrichedPersonData | null>;
  companiesCSV: string; // for company searches, store CSV directly
  enrichedCount: number;
  emailsFound: number;
  pausedUntil: number | null;
  error: string;
  createdAt: number;
  updatedAt: number;
}

export interface EnrichedPersonData {
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

// ── Blob Storage ──────────────────────────────────

const JOB_PREFIX = "jobs/";

export async function saveJob(job: Job): Promise<void> {
  job.updatedAt = Date.now();
  const path = `${JOB_PREFIX}${job.id}.json`;
  // Delete existing blob first, then write new one
  try {
    const existing = await head(path);
    if (existing) await del(existing.url);
  } catch {
    // ignore - blob may not exist yet
  }
  await put(path, JSON.stringify(job), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });
}

export async function getJob(jobId: string): Promise<Job | null> {
  try {
    const blobInfo = await head(`${JOB_PREFIX}${jobId}.json`);
    if (!blobInfo) return null;
    const resp = await fetch(blobInfo.url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export async function listJobs(): Promise<Array<{ id: string; url: string; uploadedAt: Date }>> {
  const result = await list({ prefix: JOB_PREFIX });
  return result.blobs
    .filter((b) => b.pathname.endsWith(".json"))
    .map((b) => ({
      id: b.pathname.replace(JOB_PREFIX, "").replace(".json", ""),
      url: b.url,
      uploadedAt: b.uploadedAt,
    }))
    .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}

export async function deleteJob(jobId: string): Promise<void> {
  try {
    const blobInfo = await head(`${JOB_PREFIX}${jobId}.json`);
    if (blobInfo) await del(blobInfo.url);
  } catch {
    // ignore
  }
}

export function createJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── CSV Generation ────────────────────────────────

function esc(val: string): string {
  if (!val) return "";
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function jobToCSV(job: Job): string {
  if (job.searchType === "companies") {
    return job.companiesCSV;
  }

  const headers = [
    "first_name", "last_name", "email", "personal_email", "title",
    "company", "company_domain", "location", "city", "state", "country",
    "linkedin_url", "website", "employees", "industry", "phone",
    "seniority", "departments",
  ];

  const rows = job.searchedPeopleIds.map((id) => {
    const enriched = job.enrichedPeople[id];
    if (enriched) {
      return headers.map((h) => esc(enriched[h as keyof EnrichedPersonData])).join(",");
    }
    const search = job.searchedPeopleData[id];
    if (search) {
      return [
        esc(search.first_name), esc(search.last_name_obfuscated), "", "", esc(search.title),
        esc(search.company), "", "", "", "", "", "", "", "", "", "", "", "",
      ].join(",");
    }
    return headers.map(() => "").join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}
