import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';

/**
 * Local filesystem screenshot store (spec §6). Deliberately simple for the ~30-device
 * deployment this backend targets (spec §7.1) — swap for S3/Azure Blob behind this same
 * two-function surface if volume grows.
 */
export async function persistScreenshot(deviceId: string, clientEventId: string, tempFilePath: string): Promise<{ storagePath: string; sizeBytes: number }> {
  const deviceDir = path.join(env.SCREENSHOT_STORAGE_DIR, deviceId);
  await fs.mkdir(deviceDir, { recursive: true });

  const storagePath = path.join(deviceDir, `${clientEventId}.jpg`);
  // Idempotent re-upload (spec §6): overwrite rather than duplicate.
  await fs.rename(tempFilePath, storagePath);

  const { size } = await fs.stat(storagePath);
  return { storagePath, sizeBytes: size };
}
