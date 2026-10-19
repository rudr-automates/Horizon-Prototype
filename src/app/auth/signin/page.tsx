import Link from "next/link";
import { signIn } from "@/app/auth/actions";
import { AuthForm } from "@/app/auth/auth-form";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ message?: string; next?: string }> }) {
  const { message, next } = await searchParams;
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : "";
  return <AuthForm title="Welcome back" action={signIn} submitLabel="Sign in" message={message} nextPath={next} footer={<>New to Horizon? <Link className="text-brand-strong underline" href={`/auth/signup${nextQuery}`}>Create an account</Link></>} />;
}
