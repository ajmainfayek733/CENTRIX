import { Suspense } from 'react';
import Link from 'next/link';
import { RegisterOrgForm } from './RegisterOrgForm';

export const metadata = {
  title: 'Register Organization - C E N T R I X EMS',
  description: 'Advanced organization registration and fleet onboarding portal for CENTRIX EMS.',
};

export default function RegisterOrganizationPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-xl">
        <div className="mb-7 flex flex-col items-center text-center">
          <Link href="/login" className="group mb-4 flex items-center gap-2.5">
            <span
              className="grid size-11 place-items-center rounded-lg bg-linear-135 from-brand-strong to-brand-vivid text-base font-bold text-white shadow-[0_6px_20px_rgba(14,165,233,0.35)] transition-transform group-hover:scale-105"
              aria-hidden
            >
              C
            </span>
          </Link>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-brand/20 bg-brand-soft px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-brand">
            EMS Advanced Setup
          </div>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
            Register Organization
          </h1>
          <p className="mt-1.5 max-w-md text-xs leading-relaxed text-text-secondary sm:text-[13.5px]">
            Provision a new tenant, configure fleet-wide monitoring policy, and generate your
            endpoint agent enrollment credentials.
          </p>
        </div>

        <Suspense fallback={<div className="h-96 rounded-xl border border-glass-border bg-surface/50" />}>
          <RegisterOrgForm />
        </Suspense>

        <p className="mt-6 text-center text-xs leading-relaxed text-text-tertiary">
          Enterprise Fleet Management System &bull; Single-tenant & Multi-team Architecture
        </p>
      </div>
    </main>
  );
}
