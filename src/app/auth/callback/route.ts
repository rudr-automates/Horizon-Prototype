import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.redirect(new URL("/auth/signin?message=Confirmation%20link%20is%20invalid.", request.url));

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/account", request.url));
  } catch {
    // Use a generic message; provider errors may include configuration details.
  }
  return NextResponse.redirect(new URL("/auth/signin?message=Confirmation%20could%20not%20be%20completed.", request.url));
}
