import { Router } from 'express';
import { authController } from './authController';
import { validate } from '../../middleware/validate';
import { userAuth } from '../../middleware/userAuth';
import { rateLimiter } from '../../middleware/rateLimiter';
import { registerSchema, loginSchema } from './auth.dto';

const router = Router();

// Registration & Login endpoints for Dashboard Users
router.post(
  '/register',
  rateLimiter(10, 60 * 1000),
  validate(registerSchema),
  authController.register
);

router.post(
  '/login',
  rateLimiter(10, 60 * 1000),
  validate(loginSchema),
  authController.login
);

router.get(
  '/me',
  userAuth as any,
  authController.me as any
);

/**
 * Exchanges the caller's session for a short-lived Socket.IO handshake ticket.
 *
 * Called by the dashboard's Next.js server, which holds the httpOnly session cookie; the browser
 * only ever sees the ticket. Rate limited because it mints a credential, generously because a
 * page open and every socket reconnect legitimately calls it.
 */
router.post(
  '/realtime-ticket',
  rateLimiter(60, 60 * 1000),
  userAuth as any,
  authController.realtimeTicket as any
);

export default router;
