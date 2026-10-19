import Link from "next/link";
import { signUp } from "@/app/auth/actions";
import { AuthForm } from "@/app/auth/auth-form";

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ message?: string; next?: string }> }) {
  const { message, next } = await searchParams;
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : "";
  return <AuthForm title="Create your account" action={signUp} submitLabel="Create account" message={message} nextPath={next} footer={<>Already registered? <Link className="text-brand-strong underline" href={`/auth/signin${nextQuery}`}>Sign in</Link></>} />;
}
