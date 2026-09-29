import { hashPassword } from 'better-auth/crypto';
import { auth } from '../../config/auth';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { RegisterDto, LoginDto, ResetPasswordDto } from './auth.dto';
import {
  deliverResetEmail,
  isResetDeliveryAvailable,
  issueResetSecrets,
  parseResetRecord,
  resetIdentifier,
  resetTtlMs,
  secretMatchesRecord,
  serializeResetRecord,
} from './passwordReset';

const CREDENTIAL_PROVIDER_ID = 'credential';
const INVALID_RESET_MESSAGE = 'The recovery link or code is invalid or has already been used.';
const EXPIRED_RESET_MESSAGE = 'This recovery link or code has expired. Please request a new one.';
const EXHAUSTED_RESET_MESSAGE =
  'Too many incorrect attempts. This recovery has been cancelled. Please request a new one.';
const DELIVERY_UNAVAILABLE_MESSAGE =
  'Password recovery email is not configured on this server. Contact your administrator.';

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
   * Starts password recovery by emailing a link and/or code (PASSWORD_RESET_DELIVERY).
   *
   * The response is identical for known, unknown, and deactivated addresses, and the email is
   * dispatched without being awaited so provider latency cannot be used to enumerate accounts.
   * Secrets are never returned to the caller; only HMACs are stored.
   */
  async forgotPassword(email: string) {
    if (!isResetDeliveryAvailable()) {
      throw { statusCode: 503, message: DELIVERY_UNAVAILABLE_MESSAGE };
    }

    const normalizedEmail = email.trim().toLowerCase();
    const response = {
      success: true,
      message: `If an account exists for this email, recovery instructions have been sent. They expire in ${env.PASSWORD_RESET_TTL_MINUTES} minutes.`,
      delivery: env.PASSWORD_RESET_DELIVERY,
      expiresInMinutes: env.PASSWORD_RESET_TTL_MINUTES,
    };

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { name: true, isActive: true },
    });

    if (!user || user.isActive === false) {
      return response;
    }

    const secrets = issueResetSecrets();
    const identifier = resetIdentifier(normalizedEmail);

    // Replacing inside one transaction keeps exactly one outstanding recovery per address.
    await prisma.$transaction([
      prisma.verification.deleteMany({ where: { identifier } }),
      prisma.verification.create({
        data: {
          identifier,
          value: serializeResetRecord(secrets.record),
          expiresAt: new Date(Date.now() + resetTtlMs()),
        },
      }),
    ]);

    void deliverResetEmail(
      { email: normalizedEmail, name: user.name },
      { linkToken: secrets.linkToken, code: secrets.code },
    ).catch((error: unknown) => {
      // Recipient only: secrets are never logged. The row stays so a retry simply replaces it.
      console.error(`passwordReset: failed to deliver recovery email to ${normalizedEmail}:`, error);
    });

    return response;
  }

  /**
   * Verifies a recovery link token or code and sets the new password.
   *
   * Every failure counts against PASSWORD_RESET_MAX_ATTEMPTS and the recovery is revoked once
   * the budget is spent. Consumption, the password write, and session revocation commit
   * together, and consumption is conditional on the value read, so two concurrent submissions
   * of the same secret cannot both succeed.
   */
  async resetPassword(dto: ResetPasswordDto) {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const presentedSecret = dto.token.trim();
    const identifier = resetIdentifier(normalizedEmail);

    const verification = await prisma.verification.findFirst({
      where: { identifier },
      orderBy: { createdAt: 'desc' },
    });

    if (!verification) {
      throw { statusCode: 400, message: INVALID_RESET_MESSAGE };
    }

    if (verification.expiresAt.getTime() <= Date.now()) {
      await prisma.verification.deleteMany({ where: { id: verification.id } });
      throw { statusCode: 400, message: EXPIRED_RESET_MESSAGE };
    }

    const record = parseResetRecord(verification.value);
    if (!record) {
      // Malformed or issued by the previous token-in-response scheme: revoke it.
      await prisma.verification.deleteMany({ where: { id: verification.id } });
      throw { statusCode: 400, message: INVALID_RESET_MESSAGE };
    }

    if (!secretMatchesRecord(record, presentedSecret)) {
      const attempts = record.attempts + 1;
      if (attempts >= env.PASSWORD_RESET_MAX_ATTEMPTS) {
        await prisma.verification.deleteMany({ where: { id: verification.id } });
        throw { statusCode: 400, message: EXHAUSTED_RESET_MESSAGE };
      }

      await prisma.verification.updateMany({
        where: { id: verification.id, value: verification.value },
        data: { value: serializeResetRecord({ ...record, attempts }) },
      });

      const remaining = env.PASSWORD_RESET_MAX_ATTEMPTS - attempts;
      const noun = remaining === 1 ? 'attempt' : 'attempts';
      throw { statusCode: 400, message: `${INVALID_RESET_MESSAGE} ${remaining} ${noun} remaining.` };
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, isActive: true },
    });

    if (!user || user.isActive === false) {
      await prisma.verification.deleteMany({ where: { id: verification.id } });
      throw { statusCode: 400, message: INVALID_RESET_MESSAGE };
    }

    const hashedPassword = await hashPassword(dto.newPassword);

    await prisma.$transaction(async (tx) => {
      const consumed = await tx.verification.deleteMany({
        where: { id: verification.id, value: verification.value },
      });
      if (consumed.count === 0) {
        throw { statusCode: 400, message: INVALID_RESET_MESSAGE };
      }

      const account = await tx.account.findFirst({
        where: { userId: user.id, providerId: CREDENTIAL_PROVIDER_ID },
        select: { id: true },
      });

      if (account) {
        await tx.account.update({
          where: { id: account.id },
          data: { password: hashedPassword },
        });
      } else {
        await tx.account.create({
          data: {
            userId: user.id,
            accountId: user.id,
            providerId: CREDENTIAL_PROVIDER_ID,
            password: hashedPassword,
          },
        });
      }

      // Revoke every existing session so a compromised one cannot outlive the reset.
      await tx.session.deleteMany({ where: { userId: user.id } });
    });

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
