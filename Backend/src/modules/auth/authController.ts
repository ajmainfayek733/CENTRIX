import { Request, Response, NextFunction } from 'express';
import { authService } from './authService';
import { AuthenticatedRequest } from '../../middleware/userAuth';

export class AuthController {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.registerUser(req.body);
      return res.status(201).json({
        message: 'User registered successfully',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.loginUser(req.body);
      return res.status(200).json({
        message: 'Login successful',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async me(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const user = await authService.getUserProfile(req.user.id);
      // `{ data }` like every other endpoint, so the dashboard's typed fetch wrapper does not
      // need a special case for this one route.
      return res.status(200).json({ data: user });
    } catch (error) {
      next(error);
    }
  }
}

export const authController = new AuthController();
