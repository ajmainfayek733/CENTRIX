'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

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

  const inputClass =
    'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none transition-colors placeholder:text-text-secondary/60 focus:border-brand';

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-border bg-surface p-6">
      <div>
        <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-text-secondary">
          Work email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-text-secondary">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-brand px-4 py-2 text-sm font-semibold text-brand-contrast transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'Signing inâ€¦' : 'Sign in'}
      </button>
    </form>
  );
}
