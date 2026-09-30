import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './userAuth';

export const requireRole = (...allowedRoles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized: User context missing' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Forbidden: Insufficient permissions',
        requiredRoles: allowedRoles,
        currentRole: req.user.role,
      });
    }

    next();
  };
};
