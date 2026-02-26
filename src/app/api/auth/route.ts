import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { password } = await req.json();
  const correctPassword = process.env.APP_PASSWORD;

  if (!correctPassword) {
    return NextResponse.json({ error: "No password configured" }, { status: 500 });
  }

  if (password !== correctPassword) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }

  // Generate a simple token hash from the password
  const tokenHash = process.env.AUTH_TOKEN_HASH!;

  const response = NextResponse.json({ ok: true });
  response.cookies.set("auth_token", tokenHash, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("auth_token");
  return response;
}
