import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
