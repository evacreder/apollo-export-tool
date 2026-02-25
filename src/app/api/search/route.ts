import { NextRequest, NextResponse } from "next/server";
import { parseApolloUrl, searchPeoplePage, searchCompaniesPage } from "@/lib/apollo";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { apiKey: clientKey, apolloUrl, type, page } = await req.json();
  const apiKey = clientKey || process.env.APOLLO_API_KEY;

  if (!apiKey || !apolloUrl) {
    return NextResponse.json({ error: "Missing apolloUrl" }, { status: 400 });
  }

  const searchParams = parseApolloUrl(apolloUrl);
  const pageNum = page || 1;

  try {
    if (type === "companies") {
      const result = await searchCompaniesPage(apiKey, searchParams, pageNum);
      return NextResponse.json(result);
    } else {
      const result = await searchPeoplePage(apiKey, searchParams, pageNum);
      return NextResponse.json(result);
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
