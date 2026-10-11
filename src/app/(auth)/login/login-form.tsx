"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** The ONE place a sign-in error code becomes words. Unknown email, wrong password and a suspended account all read the same. */
function loginErrorMessage(code: string): string {
  if (code.startsWith("TooManyAttempts:")) {
    const seconds = Number(code.slice("TooManyAttempts:".length));
    const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : null;
    return minutes
      ? `Too many failed attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`
      : "Too many failed attempts. Try again later.";
  }
  return "Invalid email or password.";
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const result = await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirect: false,
    });

    setLoading(false);
    if (result?.error) {
      setError(loginErrorMessage(result.error));
      return;
    }
    const next = searchParams.get("next");
    const isSafeRelativePath = !!next && next.startsWith("/") && !next.startsWith("//");
    router.push(isSafeRelativePath ? next : "/app");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Welcome back.</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {searchParams.get("registered") && (
            <p className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">
              Account created — sign in to continue.
            </p>
          )}
          {searchParams.get("notice") && (
            <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">
              {searchParams.get("notice")!.slice(0, 400)}
            </p>
          )}
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" required />
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-4">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            New here?{" "}
            <Link href="/register" className="font-medium text-primary underline-offset-4 hover:underline">
              Create an account
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
