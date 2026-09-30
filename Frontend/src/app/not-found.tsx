import { NotFoundLink, NotFoundPanel } from "@/components/NotFoundPanel";

export const metadata = { title: "404 Not found - C E N T R I X" };

/**
 * Catches URLs that do not match any route in the app. Wrapped by the root layout only, so
 * this page carries its own framing rather than assuming the dashboard shell is present.
 */
export default function RootNotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-8">
          <p className="text-sm font-semibold text-red-500">C E N T R I X</p>
          <p className="mt-1 text-xs text-text-secondary">
            Workforce productivity and attendance reporting
          </p>
        </div>

        <section className="rounded-lg border border-border bg-surface p-6 sm:p-8">
          <NotFoundPanel
            title="This address is not part of CENTRIXing & Movement Tracking Application."
            description="The URL you opened does not match any screen in the dashboard. Check for a typo, or sign in and open a page from the navigation."
            hint="If you followed a bookmark or a link from another system, it may point to a report that was moved or removed."
            actions={
              <>
                <NotFoundLink href="/overview" primary>
                  Go to dashboard
                </NotFoundLink>
                <NotFoundLink href="/login">Sign in</NotFoundLink>
              </>
            }
          />
        </section>
      </div>
    </main>
  );
}
