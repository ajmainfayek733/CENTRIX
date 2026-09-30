import { AsyncLocalStorage } from 'node:async_hooks';
import { env, isEmailDeliveryConfigured } from '../../config/env';
import { sendEmailJsTemplate, type EmailTemplateParams } from '../../lib/email/emailjs';

/**
 * Password recovery delivery for Better Auth's native reset flow.
 *
 * Better Auth owns the token: `requestPasswordReset` stores it (`reset-password:<token>` in the
 * `verifications` table), enforces the expiry (`resetPasswordTokenExpiresIn`), and consumes it
 * exactly once in `resetPassword`. This module only turns the token Better Auth hands to
 * `sendResetPassword` into an email, either sent from the server or handed to the dashboard.
 */

const RESET_PAGE_PATH = '/reset-password';
const SECONDS_PER_MINUTE = 60;

export interface ResetEmailRecipient {
  email: string;
  name: string | null;
}

/** What the dashboard needs to send the recovery email itself with @emailjs/browser. */
export interface BrowserEmailDispatch {
  serviceId: string;
  templateId: string;
  publicKey: string;
  templateParams: EmailTemplateParams;
}

/**
 * Per-request slot the browser transport uses to get the dispatch out of Better Auth's
 * `sendResetPassword` callback, which cannot return a value to the caller of `requestPasswordReset`.
 */
export interface ResetDispatchCollector {
  dispatch: BrowserEmailDispatch | null;
}

const dispatchStorage = new AsyncLocalStorage<ResetDispatchCollector>();

/** Runs `operation` so a browser-transport dispatch produced inside it lands in the collector. */
export function collectResetDispatch<T>(
  collector: ResetDispatchCollector,
  operation: () => Promise<T>,
): Promise<T> {
  return dispatchStorage.run(collector, operation);
}

export const resetTtlSeconds = (): number => env.PASSWORD_RESET_TTL_MINUTES * SECONDS_PER_MINUTE;

export function isResetDeliveryAvailable(): boolean {
  return isEmailDeliveryConfigured || env.NODE_ENV !== 'production';
}

export function isBrowserTransport(): boolean {
  return env.PASSWORD_RESET_EMAIL_TRANSPORT === 'browser';
}

/** The dashboard page that consumes the token; the token is a query parameter of that page. */
export function buildResetLink(token: string): string {
  const url = new URL(RESET_PAGE_PATH, env.FRONTEND_URL);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Template params for the recovery email. `code` and `reset_code` are kept (empty) so an
 * existing EmailJS template that still references them renders without leftover placeholders.
 */
function buildResetTemplateParams(recipient: ResetEmailRecipient, token: string): EmailTemplateParams {
  const resetLink = buildResetLink(token);

  return {
    email: recipient.email,
    link: resetLink,
    code: '',
    to_email: recipient.email,
    to_name: recipient.name?.trim() || recipient.email,
    app_name: env.APP_NAME,
    reset_link: resetLink,
    reset_code: '',
    expires_in_minutes: String(env.PASSWORD_RESET_TTL_MINUTES),
    // Human-readable lifetime for the minimal template ({{time}}), e.g. "30 min".
    time: `${env.PASSWORD_RESET_TTL_MINUTES} min`,
  };
}

function logDevelopmentRecovery(email: string, params: EmailTemplateParams): void {
  // Development only: isResetDeliveryAvailable() blocks this path in production.
  console.warn(`passwordReset: EmailJS not configured; development recovery for ${email} link=${params.link}`);
}

/** Server transport: sends the recovery email with the EmailJS Node.js SDK. */
async function deliverResetEmail(recipient: ResetEmailRecipient, token: string): Promise<void> {
  const params = buildResetTemplateParams(recipient, token);

  if (!isEmailDeliveryConfigured) {
    logDevelopmentRecovery(recipient.email, params);
    return;
  }

  await sendEmailJsTemplate(env.EMAILJS_PASSWORD_RESET_TEMPLATE_ID as string, params);
}

/**
 * Browser transport: builds what @emailjs/browser needs. Only the public key is exposed; the
 * private key is never included. Returns null when EmailJS is not configured (development),
 * after logging the recovery like the server transport does.
 */
function buildBrowserEmailDispatch(recipient: ResetEmailRecipient, token: string): BrowserEmailDispatch | null {
  const params = buildResetTemplateParams(recipient, token);

  if (
    !isEmailDeliveryConfigured ||
    !env.EMAILJS_SERVICE_ID ||
    !env.EMAILJS_PASSWORD_RESET_TEMPLATE_ID ||
    !env.EMAILJS_PUBLIC_KEY
  ) {
    logDevelopmentRecovery(recipient.email, params);
    return null;
  }

  return {
    serviceId: env.EMAILJS_SERVICE_ID,
    templateId: env.EMAILJS_PASSWORD_RESET_TEMPLATE_ID,
    publicKey: env.EMAILJS_PUBLIC_KEY,
    templateParams: params,
  };
}

/** Structural subset of Better Auth's user; `isActive` is one of our additionalFields. */
interface ResetPasswordUser {
  email?: string;
  name?: string | null;
  isActive?: boolean | null;
}

/**
 * Better Auth `emailAndPassword.sendResetPassword`.
 *
 * Deliberately does not await the provider (Better Auth documents this to avoid a timing
 * oracle that reveals which addresses have accounts). Deactivated users get no email, but the
 * caller still sees Better Auth's identical response.
 */
export function sendResetPassword({ user, token }: { user: ResetPasswordUser; token: string }): Promise<void> {
  if (user.isActive === false || !user.email) {
    return Promise.resolve();
  }

  const recipient: ResetEmailRecipient = { email: user.email, name: user.name ?? null };

  if (isBrowserTransport()) {
    const collector = dispatchStorage.getStore();
    if (collector) {
      collector.dispatch = buildBrowserEmailDispatch(recipient, token);
    }
    return Promise.resolve();
  }

  void deliverResetEmail(recipient, token).catch((error: unknown) => {
    // Recipient only: the token is never logged.
    console.error(`passwordReset: failed to deliver recovery email to ${recipient.email}:`, error);
  });
  return Promise.resolve();
}
