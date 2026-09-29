import { Suspense } from 'react';
import Link from 'next/link';
import { ForgotPasswordForm } from './ForgotPasswordForm';

export const metadata = {
  title: 'Password recovery - C E N T R I X',
  // Recovery links carry a secret in the query string; never leak it via the Referer header.
  referrer: 'no-referrer',
};

export default function ForgotPasswordPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <Link href="/login" className="mb-4">
            <span
              className="grid size-12 place-items-center rounded-lg bg-linear-135 from-brand-strong to-brand-vivid text-base font-bold text-white shadow-[0_6px_20px_rgba(14,165,233,0.35)]"
              aria-hidden
            >
              C
            </span>
          </Link>
          <h1 className="text-2xl font-semibold tracking-[-0.5px] text-text-primary">
            Password recovery
          </h1>
          <p className="mt-1 text-[13.5px] text-text-secondary">
            We will email you a reset link or verification code.
          </p>
        </div>

        <Suspense fallback={<div className="h-64" />}>
          <ForgotPasswordForm />
        </Suspense>
      </div>
    </main>
  );
}
