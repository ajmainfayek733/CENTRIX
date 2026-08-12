'use client';

import { useTransition, useState } from 'react';
import { setDeviceActive } from './actions';

/**
 * The admin kill switch from spec section 9. Deactivating makes the backend return 403 to that
 * device, which the agent treats as "stop uploading" while continuing to collect locally â€” so
 * reactivating does not leave a hole in the record.
 */
export function DeviceActions({ deviceId, isActive }: { deviceId: string; isActive: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setError(null);
    startTransition(async () => {
      try {
        await setDeviceActive(deviceId, !isActive);
      } catch {
        setError('Failed');
      }
    });
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {error && <span className="text-xs text-danger">{error}</span>}
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className={`rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
          isActive
            ? 'border-border text-text-secondary hover:border-danger hover:text-danger'
            : 'border-brand text-brand hover:bg-brand/10'
        }`}
      >
        {pending ? 'â€¦' : isActive ? 'Deactivate' : 'Reactivate'}
      </button>
    </div>
  );
}
