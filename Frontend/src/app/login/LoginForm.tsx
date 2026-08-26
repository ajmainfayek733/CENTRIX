'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Field, Input } from '@/components/ui';

/** Solid fill so the control stays readable over the page gradient in both themes. */
const SIGN_IN_CLASS =
  'w-full border border-brand-strong bg-brand-strong text-brand-contrast shadow-none hover:bg-brand hover:text-brand-contrast';

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      // Posts to the local route handler, never to the API directly: the handler is what puts
      // the session token in an httpOnly cookie the browser cannot read.
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Sign-in failed');
        setPending(false);
        return;
      }

      const next = searchParams.get('next');
      // Only same-origin paths: an attacker-supplied absolute URL here would be an open redirect.
      const destination = next?.startsWith('/') && !next.startsWith('//') ? next : '/overview';

      router.replace(destination);
      // The dashboard renders on the server against the new cookie, so the route cache has to
      // be dropped or the redirect can land on a stale signed-out render.
      router.refresh();
    } catch {
      setError('Could not reach the server. Check that the API is running.');
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="glass space-y-4 rounded-lg p-6">
      <Field label="Work email" htmlFor="email">
        <Input
          id="email"
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <Input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>

      {error && (
        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <Button type="submit" variant="ghost" disabled={pending} className={SIGN_IN_CLASS}>
        {pending ? 'Signing in...' : 'Sign in'}
      </Button>
    </form>
  );
}
