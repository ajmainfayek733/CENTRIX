import { z } from 'zod';

const RECOVERY_TOKEN_MAX_LENGTH = 128;
const PASSWORD_MIN_LENGTH = 8;
// Better Auth's default maxPasswordLength.
const PASSWORD_MAX_LENGTH = 128;

export const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['super_admin', 'manager', 'auditor']).optional().default('manager'),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email('Invalid email address'),
});

export const resetPasswordSchema = z.object({
  // Better Auth reset token from the emailed link.
  token: z
    .string()
    .trim()
    .min(1, 'Recovery token is required')
    .max(RECOVERY_TOKEN_MAX_LENGTH, 'Recovery token is invalid'),
  newPassword: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`),
});

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;

