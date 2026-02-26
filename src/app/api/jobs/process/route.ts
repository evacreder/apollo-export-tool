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
  let jobId: string;
  try {
    const body = await req.json();
    jobId = body.jobId;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!jobId) {
    return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  }

  try {
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

      // Save progress every 10 enrichments to avoid losing work
      if (batchEnriched % 10 === 0) {
        await saveJob(job);
      }

      // Small delay between calls
      await new Promise((r) => setTimeout(r, 350));
    }

    if (rateLimited) {
      const pauseMs = 62 * 60 * 1000;
      job.pausedUntil = Date.now() + pauseMs;
      job.status = "paused";
      await saveJob(job);

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
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * Self-call: trigger the next batch processing after a delay.
 * For short delays, calls /process directly.
 * For long delays (rate limit), starts a wait chain via /wait
 * that sleeps 55s at a time until the pause expires.
 */
function scheduleNext(req: NextRequest, jobId: string, delayMs: number) {
  const baseUrl = new URL(req.url).origin;

  if (delayMs <= 5000) {
    fetch(`${baseUrl}/api/jobs/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    }).catch(() => {});
  } else {
    // Start a wait chain that will bridge the rate limit pause
    fetch(`${baseUrl}/api/jobs/wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    }).catch(() => {});
  }
}
