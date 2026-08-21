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
 * the role down as a prop - client components never hold auth state of their own.
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
    // to /login here - as this did before - signs out every open dashboard on an API restart and
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

/** The first letter of whatever we can address this person by, for the sidebar avatar. */
function initialOf(user: SessionUser): string {
  return (user.name || user.email || '?').trim().charAt(0).toUpperCase();
}

/**
 * The chrome, rendered with or without a resolved session.
 *
 * Shared so an outage keeps the header, the theme and a way out of the page. A degraded screen
 * that also strips the navigation traps whoever hits it on the one screen that is broken.
 *
 * Both the rail and the topbar are `sticky` against the document scroll rather than wrapping the
 * content in its own scroll container. An inner scroller looks the same until you use it: it
 * breaks scroll restoration between navigations, and it hides the page from the browser's own
 * find-in-page scrolling.
 */
function Shell({ user, children }: { user?: SessionUser; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh gap-3 p-3.5">
      {/* The rail. Hidden below md, where the same links render inside the topbar instead -
          the blueprint drops the navigation entirely at that width, which leaves a phone with
          no way between screens. */}
      <aside className="glass glass-heavy sticky top-3.5 hidden h-[calc(100dvh-1.75rem)] w-[230px] shrink-0 flex-col gap-[3px] rounded-lg px-2.5 py-[18px] md:flex">
        <Link
          href="/overview"
          className="flex items-center gap-2.5 px-3 pb-5 pt-1.5 text-[14.5px] font-semibold tracking-[-0.3px] text-text-primary"
        >
          <span
            className="grid size-7 shrink-0 place-items-center rounded-md bg-linear-135 from-brand-strong to-brand-vivid text-[13px] font-bold text-white shadow-[0_4px_14px_rgba(14,165,233,0.35)]"
            aria-hidden
          >
            C
          </span>
          C E N T R I X
        </Link>

        {/* No role means no session was resolved, and a nav that cannot honour RBAC is worse
            than none - it would offer links that 403 on arrival. */}
        {user && <NavLinks role={user.role} />}

        {user && (
          <div className="mt-auto border-t border-border px-1.5 pb-0.5 pt-3">
            <div className="flex items-center gap-2.5 rounded-md p-2">
              <span
                className="grid size-8 shrink-0 place-items-center rounded-full bg-linear-135 from-brand-strong to-violet-500 text-xs font-semibold text-white"
                aria-hidden
              >
                {initialOf(user)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-text-primary">
                  {user.name || user.email}
                </p>
                <p className="text-[11.5px] text-text-tertiary">{user.role.replace('_', ' ')}</p>
              </div>
            </div>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <header className="glass sticky top-3.5 z-20 flex min-h-[54px] items-center justify-between gap-4 rounded-lg px-[18px] py-2">
          {/* Below md this carries the navigation; above it, the brand lives in the rail and
              this side stays empty so the topbar reads as a quiet strip. */}
          <div className="flex min-w-0 items-center gap-3 md:hidden">
            {user ? (
              <NavLinks role={user.role} orientation="horizontal" />
            ) : (
              <Link href="/overview" className="text-sm font-semibold text-text-primary">
                C E N T R I X
              </Link>
            )}
          </div>
          <div className="hidden md:block" />

          <div className="flex shrink-0 items-center gap-2.5">
            <ThemeToggle />
            {user && <SignOutButton />}
          </div>
        </header>

        <main className="flex-1 pb-2">
          {user && <ConnectionBanner />}
          {children}
        </main>
      </div>
    </div>
  );
}
