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

export default router;
