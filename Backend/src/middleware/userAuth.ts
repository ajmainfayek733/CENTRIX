import { Request, Response, NextFunction } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../config/auth';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  isActive: boolean;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  session?: any;
}

export const userAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session || !session.user) {
      return res.status(401).json({ error: 'Unauthorized: Session missing or expired' });
    }

    if (session.user.isActive === false) {
      return res.status(403).json({ error: 'Forbidden: Account deactivated' });
    }

    req.user = session.user as AuthenticatedUser;
    req.session = session.session;
    next();
  } catch (error) {
    console.error('userAuth Middleware Error:', error);
    return res.status(401).json({ error: 'Unauthorized: Authentication failed' });
  }
};
