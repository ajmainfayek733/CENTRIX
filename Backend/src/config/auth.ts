import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { prismaAdapter } from '@better-auth/prisma-adapter';
import { prisma } from './db';
import { env } from './env';

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,

  // The dashboard is a separate Next.js origin that keeps the session token in its own
  // httpOnly cookie and forwards it as `Authorization: Bearer <token>` from server
  // components and route handlers (see Docs/Frontend/NextJS.md section 3). Without this
  // plugin Better Auth only reads its own cookie, and every proxied request would 401.
  plugins: [bearer()],

  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
  },
  user: {
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        defaultValue: 'manager',
        input: true,
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
