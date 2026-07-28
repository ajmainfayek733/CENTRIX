import multer from 'multer';
import os from 'os';
import path from 'path';
import { Request, Response, NextFunction } from 'express';

const tempUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(null, `screenshot-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname) || '.jpg'}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'image/jpeg') {
      cb(new Error('Only image/jpeg uploads are accepted'));
      return;
    }
    cb(null, true);
  },
});

/** Wraps multer's single-file upload so its errors flow through the standard error handler as 400s. */
export function uploadScreenshotFile(req: Request, res: Response, next: NextFunction) {
  tempUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      (err as any).statusCode = 400;
      return next(err);
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Missing multipart "file" field' });
    }
    next();
  });
}
