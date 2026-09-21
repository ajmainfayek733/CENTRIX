import { redirect } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";
import { getSessionUser, type SessionUser } from "@/lib/session";
import { ApiUnavailableError } from "@/lib/api-client";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavLinks } from "@/components/NavLinks";
import { SignOutButton } from "@/components/SignOutButton";
import { RealtimeProvider } from "@/components/RealtimeProvider";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { ServiceUnavailable } from "@/components/ServiceUnavailable";
import { TopbarSearch } from "@/components/TopbarSearch";
import { NotificationBell } from "@/components/NotificationBell";
import { RefreshButton } from "@/components/RefreshButton";

/**
 * The RBAC-protected shell. Resolves the session server-side once per navigation and passes
 * the role down as a prop - client components never hold auth state of their own.
 *
 * RealtimeProvider wraps the whole dashboard so every screen updates as telemetry lands, without
 * the operator refreshing. Totals move from the aggregates pushed with each ingest event; the
 * server components are re-run only for what a delta cannot express.
 * 
 *  Is it possible to apply this method to send message to a specific employee(while monitoring after founding something suspicious we want to give the employee a warning message and the employee only can read
  the message, he can't send any reply and it also shows when the message was sent and after 24 hr automatically will vanished after read but admin can see the message whenever want)
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
    console.error("Dashboard layout: monitoring service unreachable:", error);

    return (
      <Shell>
        <ServiceUnavailable detail="Your session is unaffected. This screen recovers on its own once the service responds." />
      </Shell>
    );
  }

  // proxy.ts only checks that a cookie exists. This is where an expired or revoked
  // session is actually caught.
  if (!user) redirect("/login");

  return (
    <RealtimeProvider>
      <Shell user={user}>{children}</Shell>
    </RealtimeProvider>
  );
}

/** The first letter of whatever we can address this person by, for the sidebar avatar. */
function initialOf(user: SessionUser): string {
  return (user.name || user.email || "?").trim().charAt(0).toUpperCase();
}

/**
 * The chrome, rendered with or without a resolved session.
 *
 * Shared so an outage keeps the header, the theme and a way out of the page. A degraded screen
 * that also strips the navigation traps whoever hits it on the one screen that is broken.
 *
 * SCROLLING. The shell fills the viewport and does not scroll; the content region does, and it
 * is the only thing that does. The rail and the topbar sit outside it.
 *
 * This replaces a `sticky` topbar over a scrolling document. Sticky kept the bar in place but
 * left the content passing underneath it, which through a translucent, blurred bar reads as
 * smeared text sliding behind the controls. Taking the content out of the document's scroll and
 * giving it its own region means there is nothing to pass under: the bar is a sibling of the
 * scroller, not a layer over it.
 *
 * The cost is that browser scroll restoration no longer applies to the content region between
 * navigations - the document itself never scrolls, so there is no document scroll position to
 * restore. Every screen here opens at the top, which is where they were opened anyway.
 */
function Shell({ user, children }: { user?: SessionUser; children: ReactNode }) {
  return (
    /*
     * h-dvh + overflow-hidden, not min-h-dvh: this element is the viewport frame, and the only
     * scrollbar on the screen belongs to <main> below.
     */
    <div className="flex h-dvh gap-3 overflow-hidden p-3.5">
      {/* The rail. Hidden below md, where the same links render inside the topbar instead -
          the blueprint drops the navigation entirely at that width, which leaves a phone with
          no way between screens. */}
      <aside className="glass glass-heavy hidden h-full w-[230px] shrink-0 flex-col gap-[3px] overflow-y-auto rounded-lg px-2.5 py-[18px] md:flex">
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
                <p className="text-[11.5px] text-text-tertiary">{user.role.replace("_", " ")}</p>
              </div>
            </div>
          </div>
        )}
      </aside>

      {/* min-h-0 so this column may be shorter than its content, which is what lets the scroll
          region below actually scroll instead of stretching the shell past the viewport. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <header className="glass flex min-h-[54px] shrink-0 items-center justify-between gap-4 rounded-lg px-[18px] py-2">
          {/* Below md this carries the navigation; above it, the brand lives in the rail and
              this side holds the search pill. */}
          <div className="flex min-w-0 items-center gap-3">
            <div className="md:hidden">
              {user ? (
                <NavLinks role={user.role} orientation="horizontal" />
              ) : (
                <Link href="/overview" className="text-sm font-semibold text-text-primary">
                  C E N T R I X
                </Link>
              )}
            </div>
            <TopbarSearch />
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            <ThemeToggle />
            {/* Both need the realtime context and the router, so they only exist for a resolved
                session - the degraded shell renders without a RealtimeProvider around it. */}
            {user && <NotificationBell />}
            {user && <RefreshButton />}
            {user && <SignOutButton />}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto pb-2 lg:pr-5 pr-2.5">
          {user && <ConnectionBanner />}
          {children}
        </main>
      </div>
    </div>
  );
}
