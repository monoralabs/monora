"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Mode = "signin" | "signup";

const inputClass =
  "w-full rounded-sm border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
    />
  </svg>
);

function Wordmark({ subtitle }: { subtitle: string }) {
  return (
    <div className="mb-8 flex flex-col items-center text-center">
      <a
        href="https://monora.ai"
        className="flex flex-col items-center transition-opacity hover:opacity-80"
        aria-label="Monora"
      >
        <svg viewBox="0 0 76 76" className="mb-2.5 size-9" aria-hidden="true">
          <defs>
            <linearGradient id="auth-sun" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#F4A24C" />
              <stop offset="1" stopColor="#E2613E" />
            </linearGradient>
            <clipPath id="auth-cut">
              <rect x="0" y="0" width="76" height="46" />
            </clipPath>
          </defs>
          <g stroke="#E2613E" strokeWidth="3" strokeLinecap="round">
            <line x1="38" y1="6" x2="38" y2="15" />
            <line x1="15" y1="15" x2="21" y2="21" />
            <line x1="61" y1="15" x2="55" y2="21" />
          </g>
          <circle
            cx="38"
            cy="44"
            r="21"
            fill="url(#auth-sun)"
            clipPath="url(#auth-cut)"
          />
          <line
            x1="8"
            y1="46"
            x2="68"
            y2="46"
            stroke="currentColor"
            strokeWidth="3.4"
            strokeLinecap="round"
            className="text-foreground"
          />
        </svg>
        <span className="wordmark text-2xl">Monora</span>
      </a>
      <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

export function AuthForm({
  callbackURL = "/brains",
  invitedEmail,
}: {
  callbackURL?: string;
  /** When set (invitation flow), the email is fixed and a one-time code is the
   *  primary way in - no password to invent, and entering the code proves the
   *  user owns the invited inbox (so the account lands already verified). */
  invitedEmail?: string;
}) {
  // The invitation flow gets its own OTP-first card; the plain sign-in page
  // keeps its existing email/password + Google + magic-link form.
  return invitedEmail ? (
    <InviteAuth callbackURL={callbackURL} invitedEmail={invitedEmail} />
  ) : (
    <PasswordAuth callbackURL={callbackURL} />
  );
}

function InviteAuth({
  callbackURL,
  invitedEmail,
}: {
  callbackURL: string;
  invitedEmail: string;
}) {
  const router = useRouter();
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function sendCode() {
    setError(null);
    setLoading(true);
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: invitedEmail,
        type: "sign-in",
      });
      if (error) throw new Error(error.message);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the code");
    } finally {
      setLoading(false);
    }
  }

  async function verify() {
    if (otp.trim().length < 6) {
      setError("Enter the 6-digit code");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      // Creates the account (already verified) if it doesn't exist, then signs
      // in. callbackURL brings them back to the accept page.
      const { error } = await authClient.signIn.emailOtp({
        email: invitedEmail,
        otp: otp.trim(),
      });
      if (error) throw new Error(error.message);
      router.push(callbackURL);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid or expired code");
    } finally {
      setLoading(false);
    }
  }

  async function google() {
    setError(null);
    await authClient.signIn.social({ provider: "google", callbackURL });
  }

  return (
    <div className="w-full max-w-sm">
      <Wordmark subtitle="Set up your account to accept" />
      <Card>
        <CardContent className="space-y-3 p-6">
          <Button
            variant="outline"
            className="w-full gap-2.5"
            onClick={google}
          >
            <GoogleIcon /> Continue with Google
          </Button>

          <div className="flex items-center gap-3 py-1 text-xs text-faint">
            <span className="h-px flex-1 bg-border" /> or{" "}
            <span className="h-px flex-1 bg-border" />
          </div>

          <input
            type="email"
            value={invitedEmail}
            readOnly
            aria-label="Invited email"
            className={`${inputClass} cursor-not-allowed text-muted-foreground`}
          />

          {!sent ? (
            <Button className="w-full" onClick={sendCode} disabled={loading}>
              {loading ? "..." : "Email me a sign-in code"}
            </Button>
          ) : (
            <>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                value={otp}
                onChange={(e) =>
                  setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                onKeyDown={(e) => e.key === "Enter" && verify()}
                className={`${inputClass} tracking-[0.3em]`}
              />
              <Button className="w-full" onClick={verify} disabled={loading}>
                {loading ? "..." : "Verify & continue"}
              </Button>
              <button
                onClick={sendCode}
                disabled={loading}
                className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
              >
                Resend code
              </button>
            </>
          )}

          {error && (
            <p className="rounded-md bg-accent-light p-2 text-center text-xs text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
      <p className="mt-5 text-center text-sm text-muted-foreground">
        We&apos;ll send a code to <strong>{invitedEmail}</strong>.
      </p>
    </div>
  );
}

function PasswordAuth({ callbackURL }: { callbackURL: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await authClient.signUp.email({
          name: name || email.split("@")[0]!,
          email,
          password,
          callbackURL,
        });
        if (error) throw new Error(error.message);
        // Email verification is required, so the user can't sign in yet - tell
        // them to check their inbox instead of bouncing them to a gated page.
        setNotice("Check your inbox to confirm your email, then sign in.");
        setMode("signin");
        return;
      }
      const { error } = await authClient.signIn.email({
        email,
        password,
        callbackURL,
      });
      if (error) throw new Error(error.message);
      router.push(callbackURL);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function social(provider: "google") {
    setError(null);
    await authClient.signIn.social({ provider, callbackURL });
  }

  async function magicLink() {
    if (!email) {
      setError("Enter your email first");
      return;
    }
    setError(null);
    const { error } = await authClient.signIn.magicLink({ email, callbackURL });
    if (error) setError(error.message ?? "Could not send link");
    else setMagicSent(true);
  }

  return (
    <div className="w-full max-w-sm">
      <Wordmark
        subtitle={
          mode === "signin"
            ? "Sign in to your company brain"
            : "Create your Monora account"
        }
      />

      <Card>
        <CardContent className="space-y-3 p-6">
          <Button
            variant="outline"
            className="w-full gap-2.5"
            onClick={() => social("google")}
          >
            <GoogleIcon /> Continue with Google
          </Button>

          <div className="flex items-center gap-3 py-1 text-xs text-faint">
            <span className="h-px flex-1 bg-border" /> or{" "}
            <span className="h-px flex-1 bg-border" />
          </div>

          {mode === "signup" && (
            <input
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          )}
          <input
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            className={inputClass}
          />

          {error && (
            <p className="rounded-md bg-accent-light p-2 text-center text-xs text-destructive">
              {error}
            </p>
          )}
          {notice && (
            <p className="rounded-md bg-accent-subtle p-2 text-center text-xs text-accent">
              {notice}
            </p>
          )}

          <Button className="w-full" onClick={onSubmit} disabled={loading}>
            {loading
              ? "..."
              : mode === "signin"
                ? "Sign in"
                : "Create account"}
          </Button>

          {magicSent ? (
            <p className="rounded-md bg-accent-subtle p-2 text-center text-xs text-accent">
              Check your inbox for a sign-in link.
            </p>
          ) : (
            <button
              onClick={magicLink}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
            >
              or email me a magic link
            </button>
          )}
        </CardContent>
      </Card>

      <p className="mt-5 text-center text-sm text-muted-foreground">
        {mode === "signin" ? "No account yet?" : "Already have an account?"}{" "}
        <button
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
            setNotice(null);
          }}
          className="font-medium text-accent hover:underline"
        >
          {mode === "signin" ? "Sign up" : "Sign in"}
        </button>
      </p>
    </div>
  );
}
