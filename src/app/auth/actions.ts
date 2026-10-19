"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { safeAuthReturnPath } from "@/lib/auth/return-path";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function passwordField(formData: FormData): string {
  const value = formData.get("password");
  return typeof value === "string" ? value : "";
}

function authPath(mode: "signin" | "signup", message: string, next: string): never {
  redirect(`/auth/${mode}?message=${encodeURIComponent(message)}&next=${encodeURIComponent(next)}`);
}

export async function signIn(formData: FormData) {
  const email = field(formData, "email").toLowerCase();
  const password = passwordField(formData);
  const next = safeAuthReturnPath(field(formData, "next"));
  if (!email || !password || email.length > 254 || password.length > 1024) {
    authPath("signin", "Enter a valid email and password.", next);
  }

  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    authPath("signin", "Sign-in is temporarily unavailable.", next);
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) authPath("signin", "We could not sign you in with those details.", next);
  redirect(next);
}

export async function signUp(formData: FormData) {
  const email = field(formData, "email").toLowerCase();
  const password = passwordField(formData);
  const next = safeAuthReturnPath(field(formData, "next"));
  if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12 || password.length > 1024) {
    authPath("signup", "Use a valid email and a password with at least 12 characters.", next);
  }

  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    authPath("signup", "Account creation is temporarily unavailable.", next);
  }
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: new URL(
        "/auth/callback",
        process.env.NEXT_PUBLIC_SITE_URL || "https://horizon-prototype.vercel.app",
      ).toString(),
    },
  });
  if (error) authPath("signup", "We could not create an account with those details.", next);
  if (!data.session) redirect("/auth/check-email");
  redirect(next);
}

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/");
}
