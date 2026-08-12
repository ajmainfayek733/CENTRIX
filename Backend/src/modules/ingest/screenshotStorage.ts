import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';

/**
 * Local filesystem screenshot store (spec section 6). Deliberately simple for the ~30-device
 * deployment this backend targets (spec section 7.1) - swap for S3/Azure Blob behind this same
 * two-function surface if volume grows.
 */
export async function persistScreenshot(deviceId: string, clientEventId: string, tempFilePath: string): Promise<{ storagePath: string; sizeBytes: number }> {
  const deviceDir = path.join(env.SCREENSHOT_STORAGE_DIR, deviceId);
  await fs.mkdir(deviceDir, { recursive: true });

  const storagePath = path.join(deviceDir, `${clientEventId}.jpg`);

  // Idempotent re-upload (spec section 6): overwrite rather than duplicate.
  try {
    await fs.rename(tempFilePath, storagePath);
  } catch (error) {
    // rename cannot cross a volume boundary. `upload.ts` stages inside this same root so the
    // fast path holds, but a caller that hands over a file from elsewhere - the OS temp
    // directory on another drive, say - must not fail the upload outright.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;

    await fs.copyFile(tempFilePath, storagePath);
    await fs.unlink(tempFilePath).catch(() => undefined);
  }

  const { size } = await fs.stat(storagePath);
  return { storagePath, sizeBytes: size };
}
