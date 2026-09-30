import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "../../config/env";

const s3 =
  env.SCREENSHOT_STORAGE_PROVIDER === "s3"
    ? new S3Client({
        region: env.SCREENSHOT_S3_REGION,
        endpoint: env.SCREENSHOT_S3_ENDPOINT,
        forcePathStyle: env.SCREENSHOT_S3_FORCE_PATH_STYLE,
      })
    : undefined;

function objectKey(deviceId: string, clientEventId: string) {
  return `${deviceId}/${clientEventId}.jpg`;
}

function bucket() {
  if (!env.SCREENSHOT_S3_BUCKET) {
    throw new Error("SCREENSHOT_S3_BUCKET is required when SCREENSHOT_STORAGE_PROVIDER=s3");
  }
  return env.SCREENSHOT_S3_BUCKET;
}

export type ScreenshotObject = {
  body: NodeJS.ReadableStream;
  contentType: string;
  contentLength?: number;
};

export async function persistScreenshot(
  deviceId: string,
  clientEventId: string,
  tempFilePath: string,
): Promise<{ storagePath: string; sizeBytes: number }> {
  if (env.SCREENSHOT_STORAGE_PROVIDER === "s3") {
    const key = objectKey(deviceId, clientEventId);
    const { size } = await fs.stat(tempFilePath);
    await s3!.send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: fsSync.createReadStream(tempFilePath),
        ContentType: "image/jpeg",
        ContentLength: size,
      }),
    );
    await fs.unlink(tempFilePath).catch(() => undefined);
    return { storagePath: key, sizeBytes: size };
  }

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
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;

    await fs.copyFile(tempFilePath, storagePath);
    await fs.unlink(tempFilePath).catch(() => undefined);
  }

  const { size } = await fs.stat(storagePath);
  return { storagePath, sizeBytes: size };
}

/** S3 DeleteObjects accepts at most this many keys per request. */
export const S3_DELETE_MAX_KEYS = 1_000;

/**
 * Removes stored screenshot bytes.
 *
 * Returns the storage paths that are confirmed gone - deleted now, or already absent. Callers
 * must drop a database row only for a path in the returned set, so a transient storage failure
 * leaves the row in place for the next sweep instead of orphaning the file.
 */
export async function deleteScreenshots(storagePaths: string[]): Promise<Set<string>> {
  const removed = new Set<string>();
  if (storagePaths.length === 0) return removed;

  if (env.SCREENSHOT_STORAGE_PROVIDER === "s3") {
    for (let start = 0; start < storagePaths.length; start += S3_DELETE_MAX_KEYS) {
      const chunk = storagePaths.slice(start, start + S3_DELETE_MAX_KEYS);
      try {
        const response = await s3!.send(
          new DeleteObjectsCommand({
            Bucket: bucket(),
            Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        // Quiet mode reports only failures; everything else in the chunk is gone.
        const failed = new Set((response.Errors ?? []).map((item) => item.Key));
        for (const key of chunk) if (!failed.has(key)) removed.add(key);
        if (failed.size > 0) {
          console.error(`screenshot retention: S3 refused ${failed.size} delete(s)`);
        }
      } catch (error) {
        console.error("screenshot retention: S3 delete request failed:", error);
      }
    }
    return removed;
  }

  for (const storagePath of storagePaths) {
    try {
      await fs.unlink(storagePath);
      removed.add(storagePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        removed.add(storagePath);
      } else {
        console.error(`screenshot retention: could not delete ${storagePath}:`, error);
      }
    }
  }
  return removed;
}

export async function getScreenshot(
  deviceId: string,
  storagePath: string,
): Promise<ScreenshotObject> {
  if (env.SCREENSHOT_STORAGE_PROVIDER === "s3") {
    const response = await s3!.send(new GetObjectCommand({ Bucket: bucket(), Key: storagePath }));
    if (!response.Body) throw new Error("S3 returned an empty screenshot body");
    return {
      body: response.Body as NodeJS.ReadableStream,
      contentType: response.ContentType ?? "image/jpeg",
      contentLength: response.ContentLength,
    };
  }

  const { size } = await fs.stat(storagePath);
  return {
    body: fsSync.createReadStream(storagePath),
    contentType: "image/jpeg",
    contentLength: size,
  };
}
