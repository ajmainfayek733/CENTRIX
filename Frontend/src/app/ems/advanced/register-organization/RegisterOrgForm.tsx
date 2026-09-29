'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, useToast } from '@/components/ui';

const PRIMARY_BTN_CLASS =
  'w-full inline-flex items-center justify-center gap-2 rounded-lg bg-brand-strong px-4 py-2.5 text-xs font-semibold text-brand-contrast shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_12px_rgba(14,165,233,0.25)] transition-all hover:bg-brand hover:shadow-[0_2px_4px_rgba(0,0,0,0.05),0_6px_20px_rgba(14,165,233,0.35)] active:scale-[0.98] disabled:opacity-50';

const SECONDARY_BTN_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-glass-border bg-surface-muted px-4 py-2 text-xs font-medium text-text-primary transition-all hover:bg-row-hover hover:border-border-strong';

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

    if (!orgName.trim() || orgName.trim().length < 2) {
      setError('Organization name must be at least 2 characters long.');
      return;
    }

    if (!adminEmail.trim()) {
      setError('Admin email address is required.');
      return;
    }

    if (!adminPassword || adminPassword.length < 8) {
      setError('Admin password must be at least 8 characters long.');
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
          adminName: adminName.trim() || 'Organization Administrator',
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

      setRegistrationResult(body.data);
      toast.success(`Successfully provisioned ${orgName}.`, 'Organization Registered');
    } catch {
      const msg = 'Could not communicate with the server. Please verify the backend service is running.';
      setError(msg);
      toast.error(msg, 'Network Error');
    } finally {
      setPending(false);
    }
  }

  function copyEnrollmentToken() {
    if (!registrationResult?.enrollmentToken) return;
    navigator.clipboard.writeText(registrationResult.enrollmentToken);
    setCopiedToken(true);
    toast.success('Agent enrollment token copied to clipboard.', 'Token Copied');
    setTimeout(() => setCopiedToken(false), 3000);
  }

  if (registrationResult) {
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
            <h2 className="text-lg font-semibold text-text-primary">
              Organization Successfully Provisioned
            </h2>
            <p className="text-xs text-text-secondary">
              Your organization and super administrator account have been created.
            </p>
          </div>
        </div>

        <div className="space-y-4 rounded-lg border border-glass-border bg-surface-muted p-4 text-xs">
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <span className="text-text-tertiary">Organization Name:</span>
              <p className="font-semibold text-text-primary">{registrationResult.organization.name}</p>
            </div>
            <div>
              <span className="text-text-tertiary">Super Admin Account:</span>
              <p className="font-semibold text-text-primary">
                {registrationResult.adminUser?.email || adminEmail}
              </p>
            </div>
          </div>

          <div className="border-t border-border pt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium text-text-primary">Fleet Agent Enrollment Token</span>
              <span className="rounded bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-danger">
                Shown Once Only
              </span>
            </div>
            <div className="flex items-center gap-2">
              <code className="block flex-1 overflow-x-auto rounded border border-border bg-surface-strong px-3 py-2 font-mono text-[11px] text-text-primary">
                {registrationResult.enrollmentToken}
              </code>
              <button
                type="button"
                onClick={copyEnrollmentToken}
                className={SECONDARY_BTN_CLASS}
                title="Copy Token"
              >
                {copiedToken ? (
                  <span className="text-success font-semibold">Copied!</span>
                ) : (
                  <span>Copy Token</span>
                )}
              </button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-text-tertiary">
              Store this token in your Windows Agent installer or GPO configuration. It is hashed
              and cannot be viewed again.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-2 sm:flex-row">
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push(`/login?email=${encodeURIComponent(adminEmail)}`)}
            className={PRIMARY_BTN_CLASS}
          >
            Sign In with Administrator Account
          </Button>
          <Link
            href="/login"
            className="flex items-center justify-center rounded-lg border border-border px-4 py-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-row-hover hover:text-text-primary"
          >
            Back to Sign In
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="glass space-y-5 rounded-xl border border-glass-border bg-surface p-6 shadow-glass-md sm:p-8">
      <div className="border-b border-border pb-4">
        <h2 className="text-base font-semibold tracking-tight text-text-primary">
          Organization Details
        </h2>
        <p className="mt-0.5 text-xs text-text-secondary">
          Configure the root tenant name for your telemetry fleet.
        </p>
      </div>

      <Field label="Organization Name" htmlFor="orgName">
        <Input
          id="orgName"
          type="text"
          required
          placeholder="e.g. Acme Corporation, Global Logistics"
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
        />
      </Field>

      <div className="border-b border-border pb-1 pt-2">
        <h2 className="text-base font-semibold tracking-tight text-text-primary">
          Master Administrator Credentials
        </h2>
        <p className="mt-0.5 text-xs text-text-secondary">
          Primary super_admin account that has full access to policy, reports, and settings.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Administrator Full Name" htmlFor="adminName">
          <Input
            id="adminName"
            type="text"
            placeholder="e.g. John Doe"
            value={adminName}
            onChange={(e) => setAdminName(e.target.value)}
          />
        </Field>

        <Field label="Administrator Work Email" htmlFor="adminEmail">
          <Input
            id="adminEmail"
            type="email"
            required
            autoComplete="email"
            placeholder="admin@company.com"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Master Password" htmlFor="adminPassword">
          <Input
            id="adminPassword"
            type="password"
            required
            autoComplete="new-password"
            placeholder="Minimum 8 characters"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
          />
        </Field>

        <Field label="Confirm Master Password" htmlFor="confirmPassword">
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

      <div className="pt-2">
        <Button
          type="submit"
          variant="ghost"
          disabled={pending}
          className={PRIMARY_BTN_CLASS}
        >
          {pending ? 'Registering Organization...' : 'Register & Provision Organization'}
        </Button>
      </div>

      <p className="text-center text-xs text-text-tertiary">
        Already have an organization registered?{' '}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign In
        </Link>
      </p>
    </form>
  );
}
