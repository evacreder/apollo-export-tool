import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  // Allow the auth API route through
  if (req.nextUrl.pathname === "/api/auth") {
    return NextResponse.next();
  }

  const token = req.cookies.get("auth_token")?.value;
  const expected = process.env.AUTH_TOKEN_HASH;

  if (!expected || token !== expected) {
    // For API routes, return 401
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // For page routes, let them through - the page will show the login screen
    // We pass auth status via a header that the page can check
    const response = NextResponse.next();
    response.headers.set("x-authenticated", "false");
    return response;
  }

  const response = NextResponse.next();
  response.headers.set("x-authenticated", "true");
  return response;
}

export const config = {
  matcher: ["/", "/api/:path*"],
};
