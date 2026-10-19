import Link from "next/link";
import { signUp } from "@/app/auth/actions";
import { AuthForm } from "@/app/auth/auth-form";

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ message?: string }> }) {
  const { message } = await searchParams;
  return <AuthForm title="Create your account" action={signUp} submitLabel="Create account" message={message} footer={<>Already registered? <Link className="text-brand-strong underline" href="/auth/signin">Sign in</Link></>} />;
}
