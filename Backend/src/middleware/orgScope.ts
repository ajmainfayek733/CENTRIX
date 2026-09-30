import { NextFunction, Response } from 'express';
import { currentOrganizationId } from '../config/tenant';
import { AuthenticatedRequest, AuthenticatedUser } from './userAuth';

/**
 * The organization a dashboard user administers.
 *
 * Users carry `organizationId`. Rows created before that link existed have none, and resolve to
 * the deployment's original (oldest) organization, which is what they were implicitly bound to.
 */
export async function resolveUserOrganizationId(user: AuthenticatedUser): Promise<string> {
  return user.organizationId ?? currentOrganizationId();
}

async function denyUnlessOwn(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  requestedOrganizationId: unknown,
): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized: User context missing' });
      return;
    }

    const own = await resolveUserOrganizationId(req.user);
    if (requestedOrganizationId !== own) {
      // 404 rather than 403: do not confirm that another organization's id exists.
      res.status(404).json({ error: 'Organization not found' });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}

/** `router.param('id', ...)` handler: `/:id/...` must be the caller's own organization. */
export function requireOwnOrganizationParam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  id: string,
): void {
  void denyUnlessOwn(req, res, next, id);
}

/** Route middleware: `body.organizationId` must be the caller's own organization. */
export function requireOwnOrganizationBody(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  void denyUnlessOwn(req, res, next, (req.body as { organizationId?: unknown } | undefined)?.organizationId);
}
