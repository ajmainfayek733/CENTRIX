import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import { Request, Response, NextFunction } from "express";
import { env } from "../../config/env";

/**
 * Uploads are staged inside the screenshot storage root for local storage, or the OS temp
 * directory for S3. The latter avoids treating ephemeral container disk as durable storage.
 *
 * `persistScreenshot` finishes the upload with a rename, and a rename only works within one
 * volume - with the default Windows temp dir on C: and a storage root on another drive, every
 * upload failed with EXDEV. Staging here keeps the final move atomic and on-volume, which is
 * also what makes a half-written file impossible to observe as a stored screenshot.
 */
const STAGING_DIR =
  env.SCREENSHOT_STORAGE_PROVIDER === "s3"
    ? path.join(os.tmpdir(), "employee-tracker-screenshots")
    : path.join(env.SCREENSHOT_STORAGE_DIR, ".incoming");

/**
 * Multipart field the JPEG bytes must arrive under.
 *
 * This is contract, not convention - the Agent sets the same name in
 * `Agent.Service/Backend/BackendClient.cs` (`ScreenshotFileFieldName`). Multer rejects any other
 * field name outright, so a change here without the matching change there fails every upload.
 */
export const SCREENSHOT_FILE_FIELD = "file";

const tempUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(STAGING_DIR, { recursive: true }, (err) => cb(err, STAGING_DIR));
    },
    filename: (_req, file, cb) =>
      cb(
        null,
        `screenshot-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname) || ".jpg"}`,
      ),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "image/jpeg") {
      cb(new Error("Only image/jpeg uploads are accepted"));
      return;
    }
    cb(null, true);
  },
});

/** Wraps multer's single-file upload so its errors flow through the standard error handler as 400s. */
export function uploadScreenshotFile(req: Request, res: Response, next: NextFunction) {
  tempUpload.single(SCREENSHOT_FILE_FIELD)(req, res, (err: unknown) => {
    if (err) {
      // Multer's own text for an unexpected field is just "Unexpected field", which says
      // nothing about what was sent or what was wanted. Since this is the exact shape a
      // client/server field-name drift takes, name both sides in the response.
      if ((err as { code?: string }).code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({
          error: `Unexpected multipart field "${(err as { field?: string }).field}"`,
          expectedField: SCREENSHOT_FILE_FIELD,
        });
      }

      (err as any).statusCode = 400;
      return next(err);
    }
    if (!req.file) {
      return res.status(400).json({ error: `Missing multipart "${SCREENSHOT_FILE_FIELD}" field` });
    }
    next();
  });
}
