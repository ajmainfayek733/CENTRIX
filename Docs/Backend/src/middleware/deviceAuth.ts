import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { hashDeviceToken } from '../utils/token';

export interface DeviceAuthenticatedRequest extends Request {
  device?: {
    id: string;
    employeeId: string;
    hostname: string;
  };
}

export const deviceAuth = async (req: DeviceAuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const deviceId = (req.headers['x-device-id'] as string) || req.query.deviceId as string;
    const rawToken = (req.headers['x-device-token'] as string) || (req.headers.authorization?.replace('Bearer ', ''));

    if (!deviceId || !rawToken) {
      return res.status(401).json({ error: 'Device authentication missing: X-Device-Id and X-Device-Token headers required' });
    }

    const device = await prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device) {
      return res.status(401).json({ error: 'Device authentication failed: Unknown device' });
    }

    const computedHash = hashDeviceToken(rawToken);
    if (computedHash !== device.tokenHash) {
      return res.status(401).json({ error: 'Device authentication failed: Invalid token' });
    }

    // Update lastSeen asynchronously
    await prisma.device.update({
      where: { id: deviceId },
      data: { lastSeen: new Date() },
    });

    req.device = {
      id: device.id,
      employeeId: device.employeeId,
      hostname: device.hostname,
    };

    next();
  } catch (error) {
    console.error('DeviceAuth Error:', error);
    return res.status(500).json({ error: 'Device authentication internal error' });
  }
};
