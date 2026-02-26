import { NextRequest, NextResponse } from "next/server";
import { listJobs, getJob } from "@/lib/jobs";

export const maxDuration = 60;

/**
 * Daily cron safety net. Checks for any stuck/paused jobs and
 * restarts processing. The wait chain should handle most cases,
 * but this catches anything that fell through.
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

    const shouldResume =
      (job.status === "paused" && job.pausedUntil && Date.now() >= job.pausedUntil) ||
      (job.status === "enriching" && job.updatedAt < Date.now() - 10 * 60 * 1000) ||
      (job.status === "paused" && job.updatedAt < Date.now() - 90 * 60 * 1000);

    if (shouldResume) {
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
