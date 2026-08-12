import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { hashDeviceApiKey } from '../utils/token';
import { touchDeviceLastSeen } from '../modules/ingest/deviceLiveness';
import type { DeviceContext } from '../modules/ingest/ingestService';

export interface DeviceAuthenticatedRequest extends Request {
  device?: DeviceContext;
}

/**
 * Authenticates the Windows Agent via its device API key (spec section 9). 401 for a missing,
 * malformed or unrecognized credential; 403 only for a device that authenticated
 * successfully but has been deliberately deactivated by an admin - the agent treats those
 * differently (retry vs. stop).
 *
 * Lookup is by HMAC on a unique indexed column, so this is a single indexed read and is
 * inherently constant-time with respect to the presented key.
 */
export const deviceAuth = async (req: DeviceAuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res
        .status(401)
        .json({ error: 'Missing or malformed Authorization header; expected "Bearer <device-api-key>"' });
    }

    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (!rawKey) {
      return res.status(401).json({ error: 'Empty bearer credential' });
    }

    const device = await prisma.device.findUnique({ where: { apiKeyHash: hashDeviceApiKey(rawKey) } });

    if (!device) {
      return res.status(401).json({ error: 'Invalid device credential' });
    }

    if (!device.isActive) {
      return res.status(403).json({ error: 'Device has been deactivated' });
    }

    // Fire-and-forget: liveness tracking must never block or fail the request it rides on.
    //
    // Throttling lives in touchDeviceLastSeen, shared with the realtime heartbeat so both paths
    // agree on what "recently seen" means. See modules/ingest/deviceLiveness.ts.
    void touchDeviceLastSeen(device.id).catch((err) =>
      console.error('deviceAuth: failed to update lastSeen:', err)
    );

    req.device = {
      id: device.id,
      employeeId: device.employeeId,
      organizationId: device.organizationId,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
    };

    next();
  } catch (error) {
    next(error);
  }
};
