import { NextRequest, NextResponse } from "next/server";

async function hashToken(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function middleware(req: NextRequest) {
  // Allow the auth API route through
  if (req.nextUrl.pathname === "/api/auth") {
    return NextResponse.next();
  }

  const token = req.cookies.get("auth_token")?.value;
  const appPassword = process.env.APP_PASSWORD;

  if (!appPassword || !token) {
    return handleUnauthed(req);
  }

  const expected = await hashToken(appPassword);
  if (token !== expected) {
    return handleUnauthed(req);
  }

  return NextResponse.next();
}

function handleUnauthed(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // For page routes, let them through - the page will show the login screen
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/api/:path*"],
};
