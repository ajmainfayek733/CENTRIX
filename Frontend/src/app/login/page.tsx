import { Suspense } from 'react';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Sign in - Employee Monitor' };

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <span
            className="mb-4 grid size-12 place-items-center rounded-lg bg-linear-135 from-brand-strong to-brand-vivid text-base font-bold text-white shadow-[0_6px_20px_rgba(14,165,233,0.35)]"
            aria-hidden
          >
            EM
          </span>
          <h1 className="text-2xl font-semibold tracking-[-0.5px] text-text-primary">
            Employee Monitor
          </h1>
          <p className="mt-1 text-[13.5px] text-text-secondary">
            Workforce reporting for managers and HR.
          </p>
        </div>

        {/* useSearchParams needs a Suspense boundary during static prerender. */}
        <Suspense fallback={<div className="h-64" />}>
          <LoginForm />
        </Suspense>

        <p className="mt-6 text-center text-xs leading-relaxed text-text-tertiary">
          Access is logged. Every report you open is recorded against your account in the audit
          trail.
        </p>
      </div>
    </main>
  );
}
