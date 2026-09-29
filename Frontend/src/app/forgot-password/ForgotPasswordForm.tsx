'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Field, Input, useToast } from '@/components/ui';

const PRIMARY_BTN_CLASS =
  'w-full inline-flex items-center justify-center gap-2 rounded-lg bg-brand-strong px-4 py-2.5 text-xs font-semibold text-brand-contrast shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_12px_rgba(14,165,233,0.25)] transition-all hover:bg-brand hover:shadow-[0_2px_4px_rgba(0,0,0,0.05),0_6px_20px_rgba(14,165,233,0.35)] active:scale-[0.98] disabled:opacity-50';

const SECONDARY_BTN_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-glass-border bg-surface-muted px-3 py-1.5 text-xs font-medium text-text-primary transition-all hover:bg-row-hover';

export function ForgotPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();

  const [step, setStep] = useState<'request' | 'reset'>(() =>
    searchParams.get('token') ? 'reset' : 'request'
  );
  const [email, setEmail] = useState(() => searchParams.get('email') ?? '');
  const [token, setToken] = useState(() => searchParams.get('token') ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState(false);

  async function handleRequestToken(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError('Please enter your work email.');
      return;
    }

    setPending(true);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = body.error || body.message || 'Failed to request password reset.';
        setError(msg);
        toast.error(msg, 'Recovery Failed');
        setPending(false);
        return;
      }

      if (body.data?.token) {
        setGeneratedToken(body.data.token);
        setToken(body.data.token);
      }

      toast.success(
        'Password recovery verification token generated successfully.',
        'Recovery Code Issued'
      );
    } catch {
      const msg = 'Could not reach server. Please check your network connection.';
      setError(msg);
      toast.error(msg, 'Network Error');
    } finally {
      setPending(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError('Email address is required.');
      return;
    }

    if (!token.trim()) {
      setError('Recovery token is required.');
      return;
    }

    if (!newPassword || newPassword.length < 8) {
      setError('New password must be at least 8 characters long.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match. Please verify your confirmation password.');
      return;
    }

    setPending(true);

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          token: token.trim(),
          newPassword,
        }),
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = body.error || body.message || 'Failed to reset password.';
        setError(msg);
        toast.error(msg, 'Reset Failed');
        setPending(false);
        return;
      }

      setResetSuccess(true);
      toast.success('Your password has been successfully reset.', 'Password Updated');
    } catch {
      const msg = 'Could not communicate with the server. Please try again.';
      setError(msg);
      toast.error(msg, 'Network Error');
    } finally {
      setPending(false);
    }
  }

  function copyToken() {
    if (!generatedToken) return;
    navigator.clipboard.writeText(generatedToken);
    setCopiedToken(true);
    toast.success('Recovery token copied to clipboard.', 'Token Copied');
    setTimeout(() => setCopiedToken(false), 3000);
  }

  if (resetSuccess) {
    return (
      <div className="glass space-y-6 rounded-xl border border-glass-border bg-surface p-6 shadow-glass-md sm:p-8">
        <div className="flex items-center gap-3 border-b border-border pb-4">
          <div className="grid size-10 place-items-center rounded-lg bg-success/15 text-success">
            <svg
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Password Reset Complete</h2>
            <p className="text-xs text-text-secondary">
              Your credentials have been securely updated.
            </p>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-text-secondary">
          You can now sign in to your CENTRIX dashboard using your updated password.
        </p>

        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push(`/login?email=${encodeURIComponent(email)}`)}
          className={PRIMARY_BTN_CLASS}
        >
          Proceed to Sign In
        </Button>
      </div>
    );
  }

  if (step === 'request') {
    return (
      <form
        onSubmit={handleRequestToken}
        className="glass space-y-5 rounded-xl border border-glass-border bg-surface p-6 shadow-glass-md sm:p-8"
      >
        <div className="border-b border-border pb-3">
          <h2 className="text-base font-semibold text-text-primary">Reset Account Password</h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Enter your registered work email to receive a recovery token.
          </p>
        </div>

        <Field label="Work Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            placeholder="admin@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        {generatedToken && (
          <div className="space-y-3 rounded-lg border border-brand/20 bg-brand-soft p-4 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-brand">Self-Service Recovery Code</span>
              <span className="rounded bg-brand/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-brand">
                Valid 60 Mins
              </span>
            </div>
            <div className="flex items-center gap-2">
              <code className="block flex-1 overflow-x-auto rounded border border-border bg-surface-strong px-3 py-2 font-mono text-[11px] text-text-primary">
                {generatedToken}
              </code>
              <button
                type="button"
                onClick={copyToken}
                className={SECONDARY_BTN_CLASS}
                title="Copy Token"
              >
                {copiedToken ? <span className="text-success font-semibold">Copied!</span> : 'Copy'}
              </button>
            </div>
            <p className="text-[11px] text-text-secondary">
              Use this recovery code to set your new account password.
            </p>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep('reset')}
              className={PRIMARY_BTN_CLASS}
            >
              Set New Password Now
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-lg bg-danger/10 px-3.5 py-2.5 text-xs text-danger">
            {error}
          </p>
        )}

        {!generatedToken && (
          <div className="space-y-3 pt-1">
            <Button
              type="submit"
              variant="ghost"
              disabled={pending}
              className={PRIMARY_BTN_CLASS}
            >
              {pending ? 'Generating Recovery Code...' : 'Request Recovery Token'}
            </Button>

            <button
              type="button"
              onClick={() => setStep('reset')}
              className="w-full text-center text-xs font-medium text-text-secondary hover:text-text-primary"
            >
              Already have a recovery token? Enter token
            </button>
          </div>
        )}

        <div className="border-t border-border pt-4 text-center">
          <Link href="/login" className="text-xs font-medium text-brand hover:underline">
            &larr; Back to Sign In
          </Link>
        </div>
      </form>
    );
  }

  return (
    <form
      onSubmit={handleResetPassword}
      className="glass space-y-5 rounded-xl border border-glass-border bg-surface p-6 shadow-glass-md sm:p-8"
    >
      <div className="border-b border-border pb-3">
        <h2 className="text-base font-semibold text-text-primary">Set New Password</h2>
        <p className="mt-0.5 text-xs text-text-secondary">
          Enter your recovery token and choose a secure new password.
        </p>
      </div>

      <Field label="Work Email" htmlFor="resetEmail">
        <Input
          id="resetEmail"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>

      <Field label="Recovery Token / Code" htmlFor="token">
        <Input
          id="token"
          type="text"
          required
          placeholder="Paste recovery token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="New Password" htmlFor="newPassword">
          <Input
            id="newPassword"
            type="password"
            required
            autoComplete="new-password"
            placeholder="Min 8 characters"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </Field>

        <Field label="Confirm Password" htmlFor="confirmPassword">
          <Input
            id="confirmPassword"
            type="password"
            required
            autoComplete="new-password"
            placeholder="Re-enter password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </Field>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-danger/10 px-3.5 py-2.5 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="space-y-3 pt-2">
        <Button
          type="submit"
          variant="ghost"
          disabled={pending}
          className={PRIMARY_BTN_CLASS}
        >
          {pending ? 'Updating Password...' : 'Reset & Save New Password'}
        </Button>

        <button
          type="button"
          onClick={() => setStep('request')}
          className="w-full text-center text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          Need a new recovery token? Request code
        </button>
      </div>

      <div className="border-t border-border pt-4 text-center">
        <Link href="/login" className="text-xs font-medium text-brand hover:underline">
          &larr; Back to Sign In
        </Link>
      </div>
    </form>
  );
}
