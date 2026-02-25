import { NextRequest, NextResponse } from "next/server";
import { enrichPersonById, EnrichedPerson } from "@/lib/apollo";

export const maxDuration = 300; // 5 min for batch enrichment

export async function POST(req: NextRequest) {
  const { apiKey: clientKey, personIds } = await req.json();
  const apiKey = clientKey || process.env.APOLLO_API_KEY;

  if (!apiKey || !personIds || !Array.isArray(personIds)) {
    return NextResponse.json({ error: "Missing personIds array" }, { status: 400 });
  }

  // Process up to 50 at a time per request
  const batch = personIds.slice(0, 50);
  const results: Record<string, EnrichedPerson | null> = {};
  let rateLimited = false;
  let enrichedCount = 0;

  for (const id of batch) {
    const result = await enrichPersonById(apiKey, id);

    if (result.rateLimited) {
      rateLimited = true;
      break;
    }

    results[id] = result.data;
    enrichedCount++;

    // Rate limit: ~0.5s between calls
    if (enrichedCount < batch.length) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  return NextResponse.json({
    results,
    enrichedCount,
    rateLimited,
    rateLimitResetMinutes: rateLimited ? 60 : 0,
  });
}
