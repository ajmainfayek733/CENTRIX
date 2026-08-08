'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    // Drops the cached server render, which would otherwise still show the signed-in shell.
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={pending}
      className="rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary disabled:opacity-50"
    >
      {pending ? '…' : 'Sign out'}
    </button>
  );
}
