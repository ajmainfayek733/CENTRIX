'use client';

import { useTransition, useState } from 'react';
import { Button } from '@/components/ui';
import { setDeviceActive } from './actions';

/**
 * The admin kill switch from spec section 9. Deactivating makes the backend return 403 to that
 * device, which the agent treats as "stop uploading" while continuing to collect locally - so
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
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={toggle}
        disabled={pending}
        className={
          isActive ? 'hover:border-danger/60 hover:text-danger' : 'border-brand/60 text-brand'
        }
      >
        {pending ? 'Working...' : isActive ? 'Deactivate' : 'Reactivate'}
      </Button>
    </div>
  );
}
