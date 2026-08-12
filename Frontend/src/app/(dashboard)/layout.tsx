import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getSessionUser, type SessionUser } from '@/lib/session';
import { ApiUnavailableError } from '@/lib/api-client';
import { ThemeToggle } from '@/components/ThemeToggle';
import { NavLinks } from '@/components/NavLinks';
import { SignOutButton } from '@/components/SignOutButton';
import { RealtimeProvider } from '@/components/RealtimeProvider';
import { ConnectionBanner } from '@/components/ConnectionBanner';
import { ServiceUnavailable } from '@/components/ServiceUnavailable';

/**
 * The RBAC-protected shell. Resolves the session server-side once per navigation and passes
 * the role down as a prop — client components never hold auth state of their own.
 *
 * RealtimeProvider wraps the whole dashboard so every screen updates as telemetry lands, without
 * the operator refreshing. Totals move from the aggregates pushed with each ingest event; the
 * server components are re-run only for what a delta cannot express.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  let user: SessionUser | null;

  try {
    user = await getSessionUser();
  } catch (error) {
    if (!(error instanceof ApiUnavailableError)) throw error;

    // The service is down, which says nothing about whether this user is signed in. Redirecting
    // to /login here — as this did before — signs out every open dashboard on an API restart and
    // sends people to a page that cannot authenticate them either. Instead the shell renders and
    // the outage is stated plainly, so the session survives and returns when the service does.
    console.error('Dashboard layout: monitoring service unreachable:', error);

    return (
      <Shell>
        <ServiceUnavailable detail="Your session is unaffected. This screen recovers on its own once the service responds." />
      </Shell>
    );
  }

  // proxy.ts only checks that a cookie exists. This is where an expired or revoked
  // session is actually caught.
  if (!user) redirect('/login');

  return (
    <RealtimeProvider>
      <Shell user={user}>{children}</Shell>
    </RealtimeProvider>
  );
}

/**
 * The chrome, rendered with or without a resolved session.
 *
 * Shared so an outage keeps the header, the theme and a way out of the page. A degraded screen
 * that also strips the navigation traps whoever hits it on the one screen that is broken.
 */
function Shell({ user, children }: { user?: SessionUser; children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
          <Link href="/overview" className="text-sm font-semibold whitespace-nowrap">
            Employee Monitor
          </Link>

          {/* No role means no session was resolved, and a nav that cannot honour RBAC is worse
              than none — it would offer links that 403 on arrival. */}
          {user && <NavLinks role={user.role} />}

          <div className="ml-auto flex items-center gap-3">
            {user && (
              <div className="hidden text-right sm:block">
                <p className="text-xs font-medium leading-tight">{user.name || user.email}</p>
                <p className="text-[11px] leading-tight text-text-secondary">
                  {user.role.replace('_', ' ')}
                </p>
              </div>
            )}
            <ThemeToggle />
            {user && <SignOutButton />}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {user && <ConnectionBanner />}
        {children}
      </main>
    </div>
  );
}
