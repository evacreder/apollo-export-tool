import { NextRequest, NextResponse } from "next/server";
import { getJob, saveJob } from "@/lib/jobs";
import { enrichPersonById } from "@/lib/apollo";

export const maxDuration = 60;

/**
 * Server-side enrichment processor. Processes one batch of enrichments
 * then calls itself to process the next batch. This creates a chain of
 * serverless invocations that runs independently of the client.
 *
 * Called with: POST /api/jobs/process { jobId }
 * Also accepts: ?secret=<PROCESS_SECRET> for self-calls
 */
export async function POST(req: NextRequest) {
  const { jobId } = await req.json();
  if (!jobId) {
    return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  }

  const job = await getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (job.status === "complete" || job.status === "error") {
    return NextResponse.json({ status: job.status, message: "Job already finished" });
  }

  // Check if still in rate limit pause
  if (job.pausedUntil && Date.now() < job.pausedUntil) {
    const remainingSec = Math.ceil((job.pausedUntil - Date.now()) / 1000);
    // Schedule next attempt after pause expires
    scheduleNext(req, jobId, remainingSec * 1000 + 5000);
    return NextResponse.json({
      status: "paused",
      remainingSeconds: remainingSec,
      message: `Rate limited. Will retry in ${Math.ceil(remainingSec / 60)} minutes.`,
    });
  }

  // Clear any expired pause
  if (job.pausedUntil) {
    job.pausedUntil = null;
    job.status = "enriching";
  }

  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    job.status = "error";
    job.error = "No API key configured";
    await saveJob(job);
    return NextResponse.json({ error: "No API key" }, { status: 500 });
  }

  // Find next batch of IDs to enrich
  const toEnrich = job.searchedPeopleIds.filter((id) => !(id in job.enrichedPeople));

  if (toEnrich.length === 0) {
    job.status = "complete";
    job.emailsFound = Object.values(job.enrichedPeople).filter((p) => p?.email).length;
    await saveJob(job);
    return NextResponse.json({ status: "complete", enrichedCount: job.enrichedCount });
  }

  // Process a batch (up to 45 to stay within function timeout)
  const BATCH_SIZE = 45;
  const batch = toEnrich.slice(0, BATCH_SIZE);
  let rateLimited = false;
  let batchEnriched = 0;

  for (const personId of batch) {
    const result = await enrichPersonById(apiKey, personId);

    if (result.rateLimited) {
      rateLimited = true;
      break;
    }

    job.enrichedPeople[personId] = result.data;
    job.enrichedCount++;
    batchEnriched++;

    if (result.data?.email) {
      job.emailsFound++;
    }

    // Small delay between calls
    await new Promise((r) => setTimeout(r, 350));
  }

  if (rateLimited) {
    const pauseMs = 62 * 60 * 1000;
    job.pausedUntil = Date.now() + pauseMs;
    job.status = "paused";
    await saveJob(job);

    // Schedule next attempt after rate limit expires
    scheduleNext(req, jobId, pauseMs + 5000);

    const remaining = toEnrich.length - batchEnriched;
    return NextResponse.json({
      status: "paused",
      batchEnriched,
      remaining,
      resumeAt: new Date(job.pausedUntil).toISOString(),
    });
  }

  // Save progress
  job.status = "enriching";
  await saveJob(job);

  // Chain: trigger next batch immediately
  const remaining = toEnrich.length - batchEnriched;
  if (remaining > 0) {
    scheduleNext(req, jobId, 1000);
  } else {
    job.status = "complete";
    job.emailsFound = Object.values(job.enrichedPeople).filter((p) => p?.email).length;
    await saveJob(job);
  }

  return NextResponse.json({
    status: job.status,
    batchEnriched,
    totalEnriched: job.enrichedCount,
    remaining,
  });
}

/**
 * Self-call: trigger the next batch processing after a delay.
 * Uses fire-and-forget fetch to our own endpoint.
 */
function scheduleNext(req: NextRequest, jobId: string, delayMs: number) {
  const baseUrl = new URL(req.url).origin;
  const processUrl = `${baseUrl}/api/jobs/process`;

  // For short delays, fire immediately (serverless will handle it)
  // For long delays (rate limit), we rely on the client polling /api/jobs
  // to trigger the next batch when it detects the pause has expired
  if (delayMs <= 5000) {
    // Fire and forget - don't await
    fetch(processUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    }).catch(() => {
      // Ignore errors on self-call
    });
  }
  // For longer delays, the client or cron will trigger the next batch
}
