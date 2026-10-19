import Link from "next/link";
import { signIn } from "@/app/auth/actions";
import { AuthForm } from "@/app/auth/auth-form";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ message?: string }> }) {
  const { message } = await searchParams;
  return <AuthForm title="Welcome back" action={signIn} submitLabel="Sign in" message={message} footer={<>New to Horizon? <Link className="text-brand-strong underline" href="/auth/signup">Create an account</Link></>} />;
}
