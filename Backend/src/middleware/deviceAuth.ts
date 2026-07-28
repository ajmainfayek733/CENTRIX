import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { hashDeviceApiKey } from '../utils/token';

export interface DeviceAuthenticatedRequest extends Request {
  device?: {
    id: string;
    employeeId: string;
    organizationId: string;
    machineId: string;
    hostname: string;
  };
}

/**
 * Authenticates the Windows Agent via its device API key (spec §2.2). Per spec §2.2/§2.3:
 * 401 for a missing/malformed/unrecognized/wrong credential, 403 only for a device that
 * authenticated successfully but has been deliberately deactivated by an admin.
 */
export const deviceAuth = async (req: DeviceAuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header; expected "Bearer <device-api-key>"' });
    }

    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (!rawKey) {
      return res.status(401).json({ error: 'Empty bearer credential' });
    }

    const apiKeyHash = hashDeviceApiKey(rawKey);
    const device = await prisma.device.findUnique({ where: { apiKeyHash } });

    if (!device) {
      return res.status(401).json({ error: 'Invalid device credential' });
    }

    if (!device.isActive) {
      return res.status(403).json({ error: 'Device has been deactivated' });
    }

    // Fire-and-forget: liveness tracking must never block or fail the request it's attached to.
    prisma.device
      .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
      .catch((err) => console.error('deviceAuth: failed to update lastSeenAt:', err));

    req.device = {
      id: device.id,
      employeeId: device.employeeId,
      organizationId: device.organizationId,
      machineId: device.machineId,
      hostname: device.hostname,
    };

    next();
  } catch (error) {
    next(error);
  }
};
