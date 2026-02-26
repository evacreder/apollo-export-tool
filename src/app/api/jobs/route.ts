import { NextRequest, NextResponse, after } from "next/server";
import {
  getJob,
  saveJob,
  listJobs,
  deleteJob,
  createJobId,
  jobToCSV,
  Job,
} from "@/lib/jobs";
import { parseApolloUrl, searchPeoplePage, searchCompaniesPage, companiesToCSV } from "@/lib/apollo";

export const maxDuration = 60;

// GET /api/jobs - list all jobs, or get one job, or download CSV
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("id");
  const action = req.nextUrl.searchParams.get("action");

  // Download CSV
  if (jobId && action === "csv") {
    const job = await getJob(jobId);
    if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const csv = jobToCSV(job);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="apollo_${job.searchType}_${jobId}.csv"`,
      },
    });
  }

  // Get single job status
  if (jobId) {
    const job = await getJob(jobId);
    if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({
      id: job.id,
      searchType: job.searchType,
      status: job.status,
      totalEntries: job.totalEntries,
      enrichedCount: job.enrichedCount,
      emailsFound: job.emailsFound,
      pausedUntil: job.pausedUntil,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      remaining: job.searchedPeopleIds.length - Object.keys(job.enrichedPeople).length,
    });
  }

  // List all jobs
  const jobRefs = await listJobs();
  const jobs = await Promise.all(
    jobRefs.slice(0, 20).map(async (ref) => {
      const job = await getJob(ref.id);
      if (!job) return null;
      return {
        id: job.id,
        searchType: job.searchType,
        status: job.status,
        totalEntries: job.totalEntries,
        enrichedCount: job.enrichedCount,
        emailsFound: job.emailsFound,
        pausedUntil: job.pausedUntil,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
    })
  );

  return NextResponse.json({ jobs: jobs.filter(Boolean) });
}

// POST /api/jobs - create a new job and start processing
export async function POST(req: NextRequest) {
  const { apolloUrl, searchType: requestedType } = await req.json();

  if (!apolloUrl) {
    return NextResponse.json({ error: "Missing apolloUrl" }, { status: 400 });
  }

  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "No API key configured" }, { status: 500 });
  }

  const searchType = requestedType || (apolloUrl.includes("/companies") ? "companies" : "people");
  const searchParams = parseApolloUrl(apolloUrl);

  const job: Job = {
    id: createJobId(),
    searchType,
    apolloUrl,
    status: "searching",
    totalEntries: 0,
    searchedPeopleIds: [],
    searchedPeopleData: {},
    enrichedPeople: {},
    companiesCSV: "",
    enrichedCount: 0,
    emailsFound: 0,
    pausedUntil: null,
    error: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Do the search phase synchronously (it's fast)
  try {
    if (searchType === "companies") {
      let allCompanies: Array<Record<string, string>> = [];
      let page = 1;
      const first = await searchCompaniesPage(apiKey, searchParams, 1);
      job.totalEntries = first.totalEntries;
      allCompanies = first.companies as unknown as Array<Record<string, string>>;

      const perPage = first.companies.length || 100;
      const totalPages = Math.min(Math.ceil(first.totalEntries / perPage), 500);

      while (page < totalPages) {
        page++;
        const data = await searchCompaniesPage(apiKey, searchParams, page);
        allCompanies = [...allCompanies, ...data.companies as unknown as Array<Record<string, string>>];
      }

      job.companiesCSV = companiesToCSV(allCompanies as never);
      job.status = "complete";
      await saveJob(job);
      return NextResponse.json({ jobId: job.id, status: "complete", totalEntries: job.totalEntries });
    }

    // People search
    let page = 1;
    const first = await searchPeoplePage(apiKey, searchParams, 1);
    job.totalEntries = first.totalEntries;

    for (const p of first.people) {
      job.searchedPeopleIds.push(p.id);
      job.searchedPeopleData[p.id] = {
        first_name: p.first_name,
        last_name_obfuscated: p.last_name_obfuscated,
        title: p.title,
        company: p.company,
      };
    }

    const perPage = first.people.length || 100;
    const totalPages = Math.min(Math.ceil(first.totalEntries / perPage), 500);

    while (page < totalPages) {
      page++;
      const data = await searchPeoplePage(apiKey, searchParams, page);
      for (const p of data.people) {
        job.searchedPeopleIds.push(p.id);
        job.searchedPeopleData[p.id] = {
          first_name: p.first_name,
          last_name_obfuscated: p.last_name_obfuscated,
          title: p.title,
          company: p.company,
        };
      }
    }

    job.status = "enriching";
    await saveJob(job);

    // Trigger background enrichment chain using after() so it survives
    const baseUrl = new URL(req.url).origin;
    after(async () => {
      await fetch(`${baseUrl}/api/jobs/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id }),
      }).catch(() => {});
    });

    return NextResponse.json({
      jobId: job.id,
      status: "enriching",
      totalEntries: job.totalEntries,
    });
  } catch (err) {
    job.status = "error";
    job.error = String(err);
    await saveJob(job);
    return NextResponse.json({ jobId: job.id, status: "error", error: String(err) }, { status: 500 });
  }
}

// DELETE /api/jobs?id=xxx
export async function DELETE(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("id");
  if (!jobId) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await deleteJob(jobId);
  return NextResponse.json({ deleted: true });
}
