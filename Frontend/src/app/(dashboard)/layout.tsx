import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSessionUser } from '@/lib/session';
import { ThemeToggle } from '@/components/ThemeToggle';
import { NavLinks } from '@/components/NavLinks';
import { SignOutButton } from '@/components/SignOutButton';
import { RealtimeProvider } from '@/components/RealtimeProvider';

/**
 * The RBAC-protected shell. Resolves the session server-side once per navigation and passes
 * the role down as a prop — client components never hold auth state of their own.
 *
 * RealtimeProvider wraps the whole dashboard so every screen updates as telemetry lands, without
 * the operator refreshing. It carries no data of its own: it listens for "something changed" and
 * re-runs these server components, so what is on screen always came from the database.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  // proxy.ts only checks that a cookie exists. This is where an expired or revoked
  // session is actually caught.
  if (!user) redirect('/login');

  return (
    <RealtimeProvider>
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
          <Link href="/overview" className="text-sm font-semibold whitespace-nowrap">
            Employee Monitor
          </Link>

          <NavLinks role={user.role} />

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-xs font-medium leading-tight">{user.name || user.email}</p>
              <p className="text-[11px] leading-tight text-text-secondary">
                {user.role.replace('_', ' ')}
              </p>
            </div>
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
    </RealtimeProvider>
  );
}
