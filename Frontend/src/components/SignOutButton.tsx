'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui';

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
    <Button type="button" variant="danger" size="sm" onClick={signOut} disabled={pending}>
      {pending ? 'Signing out...' : 'Sign out'}
    </Button>
  );
}
