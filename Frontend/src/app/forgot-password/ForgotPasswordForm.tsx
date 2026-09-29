'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Field, Input, useToast } from '@/components/ui';
import { AUTH_PRIMARY_BUTTON_CLASS } from '@/lib/auth-ui';
import { EmailSendError, parseEmailDispatch, sendDispatchedEmail } from '@/lib/emailjs';

const MIN_PASSWORD_LENGTH = 8;
const RESEND_COOLDOWN_SECONDS = 60;
const ONE_SECOND_MS = 1000;
const FORGOT_PASSWORD_PATH = '/forgot-password';
const NETWORK_ERROR_MESSAGE = 'Could not reach the server. Check that the API is running.';

type DeliveryMode = 'link' | 'code' | 'both';
type Step = 'request' | 'verify';

interface ForgotPasswordResponse {
  message?: string;
  error?: string;
  data?: { delivery?: DeliveryMode; expiresInMinutes?: number; emailDispatch?: unknown };
}

function isDeliveryMode(value: unknown): value is DeliveryMode {
  return value === 'link' || value === 'code' || value === 'both';
}

function errorMessage(body: { error?: unknown; message?: unknown }, fallback: string): string {
  if (typeof body.error === 'string' && body.error.trim()) return body.error;
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  return fallback;
}

export function ForgotPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();

  // A token in the URL means the user arrived from the emailed link.
  const [linkToken, setLinkToken] = useState(() => searchParams.get('token')?.trim() ?? '');
  const [step, setStep] = useState<Step>(() => (linkToken ? 'verify' : 'request'));
  const [email, setEmail] = useState(() => searchParams.get('email') ?? '');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [delivery, setDelivery] = useState<DeliveryMode>('both');
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState(false);

  // Remove the secret from the address bar and history as soon as it has been captured.
  useEffect(() => {
    if (!linkToken) return;
    const params = new URLSearchParams();
    const initialEmail = searchParams.get('email');
    if (initialEmail) params.set('email', initialEmail);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    window.history.replaceState(null, '', `${FORGOT_PASSWORD_PATH}${suffix}`);
  }, [linkToken, searchParams]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), ONE_SECOND_MS);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const normalizedEmail = email.trim().toLowerCase();
  const acceptsCode = !linkToken && delivery !== 'link';

  async function requestRecovery() {
    setError(null);

    if (!normalizedEmail) {
      setError('Please enter your work email.');
      return;
    }

    setPending(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail }),
      });
      const body = (await res.json().catch(() => ({}))) as ForgotPasswordResponse;

      if (!res.ok) {
        const msg = errorMessage(body, 'Failed to request password reset.');
        setError(msg);
        toast.error(msg, 'Recovery Failed');
        return;
      }

      // Present only when the backend delegates sending to the browser SDK.
      const dispatch = parseEmailDispatch(body.data?.emailDispatch);
      if (dispatch) {
        try {
          await sendDispatchedEmail(dispatch);
        } catch (sendError) {
          const msg =
            sendError instanceof EmailSendError ? sendError.message : 'Failed to send the recovery email.';
          setError(msg);
          toast.error(msg, 'Email Not Sent');
          return;
        }
      }

      const mode = isDeliveryMode(body.data?.delivery) ? body.data.delivery : 'both';
      const msg = errorMessage(
        { message: body.message },
        'If an account exists for this email, recovery instructions have been sent.',
      );
      setDelivery(mode);
      setNotice(msg);
      setCode('');
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setStep('verify');
      toast.success('Check your inbox for recovery instructions.', 'Email Sent');
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
      toast.error(NETWORK_ERROR_MESSAGE, 'Network Error');
    } finally {
      setPending(false);
    }
  }

  function handleRequestSubmit(e: React.FormEvent) {
    e.preventDefault();
    void requestRecovery();
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const secret = linkToken || code.trim();

    if (!normalizedEmail) {
      setError('Email address is required.');
      return;
    }
    if (!secret) {
      setError('Enter the verification code from your email.');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
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
        body: JSON.stringify({ email: normalizedEmail, token: secret, newPassword }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };

      if (!res.ok) {
        const msg = errorMessage(body, 'Failed to reset password.');
        setError(msg);
        toast.error(msg, 'Reset Failed');
        return;
      }

      setNewPassword('');
      setConfirmPassword('');
      setResetSuccess(true);
      toast.success('Your password has been successfully reset.', 'Password Updated');
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
      toast.error(NETWORK_ERROR_MESSAGE, 'Network Error');
    } finally {
      setPending(false);
    }
  }

  function startOver() {
    setError(null);
    setNotice(null);
    setCode('');
    setLinkToken('');
    setStep('request');
  }

  const errorBanner = error && (
    <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
      {error}
    </p>
  );

  const backToSignIn = (
    <p className="text-center text-xs text-text-secondary">
      <Link href="/login" className="font-medium text-brand hover:underline">
        Back to sign in
      </Link>
    </p>
  );

  if (resetSuccess) {
    return (
      <div className="glass space-y-4 rounded-lg p-6">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Password reset complete</h2>
          <p className="mt-1 text-xs text-text-secondary">
            You can now sign in with your new password. Other devices have been signed out.
          </p>
        </div>

        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push(`/login?email=${encodeURIComponent(normalizedEmail)}`)}
          className={AUTH_PRIMARY_BUTTON_CLASS}
        >
          Sign in
        </Button>
      </div>
    );
  }

  if (step === 'request') {
    return (
      <form onSubmit={handleRequestSubmit} className="glass space-y-4 rounded-lg p-6">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Reset password</h2>
          <p className="mt-1 text-xs text-text-secondary">
            Enter your registered work email and we will send you a reset link or verification
            code.
          </p>
        </div>

        <Field label="Work email" htmlFor="email">
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        {errorBanner}

        <div className="space-y-3">
          <Button type="submit" variant="ghost" disabled={pending} className={AUTH_PRIMARY_BUTTON_CLASS}>
            {pending ? 'Sending email...' : 'Send recovery email'}
          </Button>

          <button
            type="button"
            onClick={() => {
              setError(null);
              setStep('verify');
            }}
            className="w-full text-center text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            Already have a verification code? Enter code
          </button>
        </div>

        {backToSignIn}
      </form>
    );
  }

  // Link-only delivery and no link token yet: nothing to type, the user must open the email.
  if (!linkToken && delivery === 'link') {
    return (
      <div className="glass space-y-4 rounded-lg p-6">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Check your email</h2>
          <p className="mt-1 text-xs text-text-secondary">
            {notice ?? 'If an account exists for this email, a reset link has been sent.'} Open
            the link in the email to choose a new password.
          </p>
        </div>

        {errorBanner}

        <ResendControls
          cooldown={cooldown}
          pending={pending}
          onResend={() => void requestRecovery()}
          onChangeEmail={startOver}
        />

        {backToSignIn}
      </div>
    );
  }

  return (
    <form onSubmit={handleResetPassword} className="glass space-y-4 rounded-lg p-6">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Set new password</h2>
        <p className="mt-1 text-xs text-text-secondary">
          {linkToken
            ? 'Your recovery link has been accepted. Choose a new password.'
            : 'Enter the verification code from your email and choose a new password.'}
        </p>
      </div>

      {notice && (
        <p className="rounded-md bg-surface-muted px-3 py-2 text-xs text-text-secondary">{notice}</p>
      )}

      <Field label="Work email" htmlFor="resetEmail">
        <Input
          id="resetEmail"
          type="email"
          required
          autoComplete="email"
          readOnly={Boolean(linkToken)}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>

      {acceptsCode && (
        <Field label="Verification code" htmlFor="code">
          <Input
            id="code"
            type="text"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value.trim())}
          />
        </Field>
      )}

      <Field label="New password" htmlFor="newPassword">
        <Input
          id="newPassword"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </Field>

      <Field label="Confirm password" htmlFor="confirmPassword">
        <Input
          id="confirmPassword"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
      </Field>

      {errorBanner}

      <div className="space-y-3">
        <Button type="submit" variant="ghost" disabled={pending} className={AUTH_PRIMARY_BUTTON_CLASS}>
          {pending ? 'Saving password...' : 'Save new password'}
        </Button>

        {linkToken ? (
          <button
            type="button"
            onClick={startOver}
            className="w-full text-center text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            Link not working? Request a new one
          </button>
        ) : (
          <ResendControls
            cooldown={cooldown}
            pending={pending}
            onResend={() => void requestRecovery()}
            onChangeEmail={startOver}
          />
        )}
      </div>

      {backToSignIn}
    </form>
  );
}

function ResendControls({
  cooldown,
  pending,
  onResend,
  onChangeEmail,
}: {
  cooldown: number;
  pending: boolean;
  onResend: () => void;
  onChangeEmail: () => void;
}) {
  const linkClass =
    'text-xs font-medium text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="flex items-center justify-between gap-2">
      <button type="button" onClick={onChangeEmail} className={linkClass}>
        Use a different email
      </button>
      <button type="button" onClick={onResend} disabled={pending || cooldown > 0} className={linkClass}>
        {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend email'}
      </button>
    </div>
  );
}
