import { Suspense } from 'react';
import Link from 'next/link';
import { ForgotPasswordForm } from './ForgotPasswordForm';

export const metadata = {
  title: 'Password Recovery - C E N T R I X',
  description: 'Recover and reset your account credentials for CENTRIX EMS.',
};

export default function ForgotPasswordPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-md">
        <div className="mb-7 flex flex-col items-center text-center">
          <Link href="/login" className="group mb-4 flex items-center gap-2.5">
            <span
              className="grid size-12 place-items-center rounded-lg bg-linear-135 from-brand-strong to-brand-vivid text-base font-bold text-white shadow-[0_6px_20px_rgba(14,165,233,0.35)] transition-transform group-hover:scale-105"
              aria-hidden
            >
              C
            </span>
          </Link>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">
            Password Recovery
          </h1>
          <p className="mt-1 text-xs text-text-secondary sm:text-[13.5px]">
            CENTRIX Employee Tracking & Fleet Monitoring Application
          </p>
        </div>

        <Suspense fallback={<div className="h-64 rounded-xl border border-glass-border bg-surface/50" />}>
          <ForgotPasswordForm />
        </Suspense>

        <p className="mt-6 text-center text-xs leading-relaxed text-text-tertiary">
          Need additional assistance? Contact your system super administrator.
        </p>
      </div>
    </main>
  );
}
