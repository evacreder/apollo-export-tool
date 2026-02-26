import { NextRequest, NextResponse } from "next/server";
import { listJobs, getJob } from "@/lib/jobs";

export const maxDuration = 60;

/**
 * Cron job that runs every 5 minutes to check for paused jobs
 * whose rate limit has expired, and triggers processing for them.
 * This ensures jobs resume even when no browser is open.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobRefs = await listJobs();
  const baseUrl = new URL(req.url).origin;
  let resumed = 0;

  for (const ref of jobRefs) {
    const job = await getJob(ref.id);
    if (!job) continue;

    // Resume paused jobs whose pause has expired
    if (job.status === "paused" && job.pausedUntil && Date.now() >= job.pausedUntil) {
      fetch(`${baseUrl}/api/jobs/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id }),
      }).catch(() => {});
      resumed++;
    }

    // Also resume enriching jobs that may have stalled (no update in 5+ minutes)
    if (job.status === "enriching" && job.updatedAt < Date.now() - 5 * 60 * 1000) {
      fetch(`${baseUrl}/api/jobs/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id }),
      }).catch(() => {});
      resumed++;
    }
  }

  return NextResponse.json({ checked: jobRefs.length, resumed });
}
