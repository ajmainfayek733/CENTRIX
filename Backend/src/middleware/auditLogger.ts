import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './userAuth';
import { prisma } from '../config/db';

export const auditLogger = (action: string, getTarget?: (req: AuthenticatedRequest) => string) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    // Audit log runs on response finish if successful
    res.on('finish', async () => {
      if (res.statusCode >= 200 && res.statusCode < 300 && req.user) {
        try {
          const target = getTarget ? getTarget(req) : req.originalUrl;
          const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';

          await prisma.auditLog.create({
            data: {
              userId: req.user.id,
              action,
              target,
              ipAddress,
            },
          });
        } catch (err) {
          console.error('AuditLogger error:', err);
        }
      }
    });

    next();
  };
};
