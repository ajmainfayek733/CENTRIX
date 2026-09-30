import { APIError } from 'better-auth/api';
import { auth } from '../../config/auth';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { RegisterDto, LoginDto, ResetPasswordDto } from './auth.dto';
import {
  collectResetDispatch,
  isResetDeliveryAvailable,
  type ResetDispatchCollector,
} from './passwordReset';

const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_ERROR = 500;
const INVALID_RESET_MESSAGE = 'The recovery link is invalid, has expired, or has already been used.';
const REQUEST_FAILED_MESSAGE = 'Could not start password recovery. Please try again shortly.';
const DELIVERY_UNAVAILABLE_MESSAGE =
  'Password recovery email is not configured on this server. Contact your administrator.';

/** Better Auth error codes that describe the caller's password, safe to show verbatim. */
const PASSWORD_POLICY_CODES: ReadonlySet<string> = new Set(['PASSWORD_TOO_SHORT', 'PASSWORD_TOO_LONG']);

/** Maps a Better Auth reset failure to the API's `{ statusCode, message }` error shape. */
function toResetError(error: unknown): { statusCode: number; message: string } {
  if (error instanceof APIError) {
    const code = typeof error.body?.code === 'string' ? error.body.code : '';
    if (PASSWORD_POLICY_CODES.has(code) && error.body?.message) {
      return { statusCode: HTTP_BAD_REQUEST, message: error.body.message };
    }
    return { statusCode: HTTP_BAD_REQUEST, message: INVALID_RESET_MESSAGE };
  }
  console.error('passwordReset: resetPassword failed:', error);
  return { statusCode: HTTP_INTERNAL_ERROR, message: REQUEST_FAILED_MESSAGE };
}

export class AuthService {
  /**
   * Register a new user using Better Auth API.
   * Standard registration for dashboard managers / admins.
   */
  async registerUser(dto: RegisterDto) {
    // Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email: dto.email.trim().toLowerCase() },
    });

    if (existing) {
      throw { statusCode: 400, message: 'User with this email already exists' };
    }

    // Call Better Auth sign up API
    const response = await auth.api.signUpEmail({
      body: {
        email: dto.email.trim().toLowerCase(),
        password: dto.password,
        name: dto.name,
        role: dto.role || 'manager',
      },
    });

    return response;
  }

  /**
   * Login user via Better Auth API
   */
  async loginUser(dto: LoginDto) {
    const email = dto.email.trim().toLowerCase();

    try {
      const response = await auth.api.signInEmail({
        body: {
          email,
          password: dto.password,
        },
      });

      if (!response) {
        throw { statusCode: 401, message: 'Invalid email or password' };
      }

      const user = await prisma.user.findUnique({
        where: { email },
        select: { isActive: true },
      });

      if (user && user.isActive === false) {
        throw { statusCode: 403, message: 'This account has been deactivated' };
      }

      return response;
    } catch (error) {
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      throw { statusCode: 401, message: 'Invalid email or password' };
    }
  }

  /**
   * Starts password recovery through Better Auth's native `requestPasswordReset`.
   *
   * Better Auth issues the token and returns the same body for known and unknown addresses;
   * `sendResetPassword` (passwordReset.ts) delivers it without being awaited. In browser
   * transport the delivery payload is collected here and returned for the dashboard to send.
   */
  async forgotPassword(email: string) {
    if (!isResetDeliveryAvailable()) {
      throw { statusCode: 503, message: DELIVERY_UNAVAILABLE_MESSAGE };
    }

    const collector: ResetDispatchCollector = { dispatch: null };

    try {
      await collectResetDispatch(collector, () =>
        auth.api.requestPasswordReset({ body: { email: email.trim().toLowerCase() } }),
      );
    } catch (error) {
      console.error('passwordReset: requestPasswordReset failed:', error);
      throw { statusCode: 500, message: REQUEST_FAILED_MESSAGE };
    }

    const response = {
      success: true,
      message: `If an account exists for this email, recovery instructions have been sent. They expire in ${env.PASSWORD_RESET_TTL_MINUTES} minutes.`,
      expiresInMinutes: env.PASSWORD_RESET_TTL_MINUTES,
    };

    return collector.dispatch ? { ...response, emailDispatch: collector.dispatch } : response;
  }

  /**
   * Sets a new password through Better Auth's native `resetPassword`. Better Auth verifies the
   * token, consumes it exactly once, writes the credential, and (per `auth.ts`) revokes every
   * session of the user.
   */
  async resetPassword(dto: ResetPasswordDto) {
    try {
      await auth.api.resetPassword({
        body: { token: dto.token.trim(), newPassword: dto.newPassword },
      });
    } catch (error) {
      throw toResetError(error);
    }

    return {
      success: true,
      message: 'Password has been successfully reset. You can now sign in with your new password.',
    };
  }

  /**
   * Get current user profile by ID
   */
  async getUserProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw { statusCode: 404, message: 'User not found' };
    }

    return user;
  }
}

export const authService = new AuthService();
