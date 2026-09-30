import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { prismaAdapter } from '@better-auth/prisma-adapter';
import { prisma } from './db';
import { env } from './env';
import { resetTtlSeconds, sendResetPassword } from '../modules/auth/passwordReset';

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,

  // The dashboard is a separate Next.js origin that keeps the session token in its own
  // httpOnly cookie and forwards it as `Authorization: Bearer <token>` from server
  // components and route handlers (see Docs/frontend/session-and-auth.md). Without this
  // plugin Better Auth only reads its own cookie, and every proxied request would 401.
  plugins: [bearer()],

  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
    // Native Better Auth recovery: it issues and single-use-consumes the token; we only deliver it.
    sendResetPassword,
    resetPasswordTokenExpiresIn: resetTtlSeconds(),
    // A reset must end every existing session so a stolen one cannot outlive it.
    revokeSessionsOnPasswordReset: true,
  },
  user: {
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        defaultValue: 'manager',
        input: true,
      },
      // Set server-side only (registerOrganization); a client must never pick its own tenant.
      organizationId: {
        type: 'string',
        required: false,
        input: false,
      },
      isActive: {
        type: 'boolean',
        required: false,
        defaultValue: true,
        input: false,
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
  },
  trustedOrigins: [env.FRONTEND_URL],
});
