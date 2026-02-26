import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getJob } from "@/lib/jobs";

export const maxDuration = 60;

/**
 * Wait-and-retry endpoint. Sleeps for 55 seconds, then checks
 * if a paused job is ready to resume. If still paused, chains
 * another wait. This bridges the 62-minute rate limit gap.
 */
export async function POST(req: NextRequest) {
  const { jobId } = await req.json();
  if (!jobId) {
    return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  }

  // Sleep 55 seconds (leaving headroom for the 60s timeout)
  await new Promise((r) => setTimeout(r, 55000));

  const job = await getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Job finished while we were waiting
  if (job.status === "complete" || job.status === "error") {
    return NextResponse.json({ status: job.status, message: "Job already finished" });
  }

  const baseUrl = new URL(req.url).origin;

  // If pause has expired, trigger processing
  if (job.status === "paused" && job.pausedUntil && Date.now() >= job.pausedUntil) {
    after(async () => {
      await fetch(`${baseUrl}/api/jobs/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      }).catch(() => {});
    });
    return NextResponse.json({ status: "resumed", jobId });
  }

  // Still paused - chain another wait
  if (job.status === "paused") {
    after(async () => {
      await fetch(`${baseUrl}/api/jobs/wait`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      }).catch(() => {});
    });
    return NextResponse.json({ status: "waiting", jobId });
  }

  // If enriching but stalled, kick process
  if (job.status === "enriching") {
    after(async () => {
      await fetch(`${baseUrl}/api/jobs/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      }).catch(() => {});
    });
    return NextResponse.json({ status: "restarted", jobId });
  }

  return NextResponse.json({ status: job.status });
}
