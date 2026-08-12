import { Suspense } from 'react';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Sign in - Employee Monitor' };

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="text-xl font-semibold">Employee Monitor</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Workforce reporting for managers and HR.
          </p>
        </div>

        {/* useSearchParams needs a Suspense boundary during static prerender. */}
        <Suspense fallback={<div className="h-64" />}>
          <LoginForm />
        </Suspense>

        <p className="mt-6 text-xs leading-relaxed text-text-secondary">
          Access is logged. Every report you open is recorded against your account in the audit
          trail.
        </p>
      </div>
    </main>
  );
}
