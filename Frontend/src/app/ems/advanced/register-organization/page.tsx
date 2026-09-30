import { Suspense } from 'react';
import { RegisterOrgForm } from './RegisterOrgForm';

export const metadata = {
  title: 'Register organization - C E N T R I X EMS',
};

export default function RegisterOrganizationPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <span
            className="mb-4 grid size-12 place-items-center rounded-lg bg-linear-135 from-brand-strong to-brand-vivid text-base font-bold text-white shadow-[0_6px_20px_rgba(14,165,233,0.35)]"
            aria-hidden
          >
            C
          </span>
          <h1 className="text-2xl font-semibold tracking-[-0.5px] text-text-primary">
            Register organization
          </h1>
          <p className="mt-1 text-[13.5px] text-text-secondary">
            Provision a tenant and the enrollment token used to register organization devices.
          </p>
        </div>

        <Suspense fallback={<div className="h-64" />}>
          <RegisterOrgForm />
        </Suspense>
      </div>
    </main>
  );
}
