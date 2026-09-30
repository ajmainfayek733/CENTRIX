'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, useToast } from '@/components/ui';
import { AUTH_PRIMARY_BUTTON_CLASS, AUTH_SECONDARY_BUTTON_CLASS } from '@/lib/auth-ui';

const MIN_PASSWORD_LENGTH = 8;
const MIN_NAME_LENGTH = 2;

export function RegisterOrgForm() {
  const router = useRouter();
  const toast = useToast();

  const [orgName, setOrgName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);

  const [registrationResult, setRegistrationResult] = useState<{
    organization: { id: string; name: string };
    enrollmentToken: string;
    adminUser: { email: string; name: string | null; role: string } | null;
  } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (orgName.trim().length < MIN_NAME_LENGTH) {
      setError('Organization name must be at least 2 characters long.');
      return;
    }

    if (adminName.trim().length < MIN_NAME_LENGTH) {
      setError('Administrator name must be at least 2 characters long.');
      return;
    }

    if (!adminEmail.trim()) {
      setError('Administrator email is required.');
      return;
    }

    if (!adminPassword || adminPassword.length < MIN_PASSWORD_LENGTH) {
      setError('Administrator password must be at least 8 characters long.');
      return;
    }

    if (adminPassword !== confirmPassword) {
      setError('Passwords do not match. Please verify your confirmation password.');
      return;
    }

    setPending(true);

    try {
      const res = await fetch('/api/auth/register-organization', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: orgName.trim(),
          adminName: adminName.trim(),
          adminEmail: adminEmail.trim().toLowerCase(),
          adminPassword,
        }),
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message = body.error || body.message || 'Failed to register organization.';
        setError(message);
        toast.error(message, 'Registration Error');
        setPending(false);
        return;
      }

      const payload = body.data as typeof registrationResult;
      if (!payload?.enrollmentToken || !payload.organization) {
        const message = 'Registration succeeded but no enrollment token was returned.';
        setError(message);
        toast.error(message, 'Registration Error');
        setPending(false);
        return;
      }

      setRegistrationResult(payload);
      toast.success(`Organization ${payload.organization.name} is ready.`, 'Organization Registered');
    } catch {
      const msg = 'Could not reach the server. Check that the API is running.';
      setError(msg);
      toast.error(msg, 'Network Error');
    } finally {
      setPending(false);
    }
  }

  async function copyEnrollmentToken() {
    if (!registrationResult?.enrollmentToken) return;
    try {
      await navigator.clipboard.writeText(registrationResult.enrollmentToken);
      setCopiedToken(true);
      toast.success('Enrollment token copied to clipboard.', 'Token Copied');
      window.setTimeout(() => setCopiedToken(false), 3000);
    } catch {
      toast.error('Could not copy automatically. Select the token and copy it manually.', 'Copy Failed');
    }
  }

  if (registrationResult) {
    return (
      <div className="glass space-y-4 rounded-lg p-6">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Organization registered</h2>
          <p className="mt-1 text-xs text-text-secondary">
            Store the enrollment token now. It is required to register organization devices and
            will not be shown again.
          </p>
        </div>

        <div className="space-y-3 rounded-md border border-border bg-surface-muted p-3 text-xs">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <span className="text-text-tertiary">Organization</span>
              <p className="font-medium text-text-primary">{registrationResult.organization.name}</p>
            </div>
            <div>
              <span className="text-text-tertiary">Administrator</span>
              <p className="font-medium text-text-primary">
                {registrationResult.adminUser?.email || adminEmail}
              </p>
            </div>
          </div>

          <div className="border-t border-border pt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-medium text-text-primary">Device enrollment token</span>
              <span className="text-[11px] text-danger">Shown once</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="block min-w-0 flex-1 overflow-x-auto rounded-md border border-border-strong bg-surface-strong px-3 py-2 font-mono text-[12px] text-text-primary">
                {registrationResult.enrollmentToken}
              </code>
              <button type="button" onClick={copyEnrollmentToken} className={AUTH_SECONDARY_BUTTON_CLASS}>
                {copiedToken ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-text-tertiary">
              Pass this value as EnrollmentToken when installing the Windows agent. Only the hash
              is stored on the server.
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push(`/login?email=${encodeURIComponent(adminEmail.trim())}`)}
          className={AUTH_PRIMARY_BUTTON_CLASS}
        >
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="glass space-y-4 rounded-lg p-6">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Organization details</h2>
        <p className="mt-1 text-xs text-text-secondary">
          Creates the tenant, default policy, administrator account, and device enrollment token.
        </p>
      </div>

      <Field label="Organization name" htmlFor="orgName">
        <Input
          id="orgName"
          type="text"
          required
          minLength={MIN_NAME_LENGTH}
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
        />
      </Field>

      <Field label="Administrator name" htmlFor="adminName">
        <Input
          id="adminName"
          type="text"
          required
          minLength={MIN_NAME_LENGTH}
          autoComplete="name"
          value={adminName}
          onChange={(e) => setAdminName(e.target.value)}
        />
      </Field>

      <Field label="Administrator email" htmlFor="adminEmail">
        <Input
          id="adminEmail"
          type="email"
          required
          autoComplete="email"
          value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)}
        />
      </Field>

      <Field label="Password" htmlFor="adminPassword">
        <Input
          id="adminPassword"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
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

      {error && (
        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <Button type="submit" variant="ghost" disabled={pending} className={AUTH_PRIMARY_BUTTON_CLASS}>
        {pending ? 'Registering...' : 'Register organization'}
      </Button>

      <p className="text-center text-xs text-text-secondary">
        <Link href="/login" className="font-medium text-brand hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
