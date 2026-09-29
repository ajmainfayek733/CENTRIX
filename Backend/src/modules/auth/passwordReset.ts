import crypto from 'crypto';
import { env, isEmailDeliveryConfigured } from '../../config/env';
import { sendEmailJsTemplate, type EmailTemplateParams } from '../../lib/email/emailjs';

/**
 * Password recovery secrets and delivery.
 *
 * One recovery is outstanding per email address. It is stored as a single `verifications` row
 * whose value is a JSON record holding HMACs of the link token and/or the numeric code plus a
 * failed-attempt counter. Raw secrets only ever exist in memory and in the outgoing email.
 */

const IDENTIFIER_PREFIX = 'pwd_reset_';
const HMAC_DOMAIN = 'pwd_reset:';
const LINK_TOKEN_BYTES = 32;
const RECORD_VERSION = 1;
const DECIMAL_RADIX = 10;
const MS_PER_MINUTE = 60_000;
const RESET_PAGE_PATH = '/reset-password';

export type ResetDeliveryMode = typeof env.PASSWORD_RESET_DELIVERY;

export interface ResetRecord {
  version: typeof RECORD_VERSION;
  tokenHash: string | null;
  codeHash: string | null;
  attempts: number;
}

export interface IssuedResetSecrets {
  record: ResetRecord;
  linkToken: string | null;
  code: string | null;
}

export interface ResetEmailRecipient {
  email: string;
  name: string | null;
}

export const resetTtlMs = (): number => env.PASSWORD_RESET_TTL_MINUTES * MS_PER_MINUTE;

export function resetIdentifier(normalizedEmail: string): string {
  return `${IDENTIFIER_PREFIX}${normalizedEmail}`;
}

function hmac(secret: string): string {
  return crypto
    .createHmac('sha256', env.BETTER_AUTH_SECRET)
    .update(`${HMAC_DOMAIN}${secret}`)
    .digest('hex');
}

function hashesMatch(storedHash: string | null, presented: string): boolean {
  if (!storedHash) return false;
  const presentedHash = hmac(presented);
  if (storedHash.length !== presentedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(storedHash, 'utf8'), Buffer.from(presentedHash, 'utf8'));
}

function generateNumericCode(length: number): string {
  const upperBound = DECIMAL_RADIX ** length;
  return crypto.randomInt(0, upperBound).toString().padStart(length, '0');
}

export function issueResetSecrets(mode: ResetDeliveryMode = env.PASSWORD_RESET_DELIVERY): IssuedResetSecrets {
  const wantsLink = mode === 'link' || mode === 'both';
  const wantsCode = mode === 'code' || mode === 'both';

  const linkToken = wantsLink ? crypto.randomBytes(LINK_TOKEN_BYTES).toString('hex') : null;
  const code = wantsCode ? generateNumericCode(env.PASSWORD_RESET_CODE_LENGTH) : null;

  return {
    linkToken,
    code,
    record: {
      version: RECORD_VERSION,
      tokenHash: linkToken ? hmac(linkToken) : null,
      codeHash: code ? hmac(code) : null,
      attempts: 0,
    },
  };
}

export function serializeResetRecord(record: ResetRecord): string {
  return JSON.stringify(record);
}

/** Returns null for anything that is not a well-formed record, including legacy bare hashes. */
export function parseResetRecord(raw: string): ResetRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<ResetRecord>;
    const isHash = (value: unknown) => value === null || typeof value === 'string';
    if (
      candidate.version !== RECORD_VERSION ||
      !isHash(candidate.tokenHash) ||
      !isHash(candidate.codeHash) ||
      !Number.isInteger(candidate.attempts) ||
      candidate.attempts < 0
    ) {
      return null;
    }
    return candidate as ResetRecord;
  } catch {
    return null;
  }
}

/** Accepts either the link token or the numeric code; each is compared in constant time. */
export function secretMatchesRecord(record: ResetRecord, presented: string): boolean {
  // Evaluate both so timing does not reveal which kind of secret was configured.
  const tokenMatch = hashesMatch(record.tokenHash, presented);
  const codeMatch = hashesMatch(record.codeHash, presented);
  return tokenMatch || codeMatch;
}

export function buildResetLink(normalizedEmail: string, linkToken: string): string {
  const url = new URL(RESET_PAGE_PATH, env.FRONTEND_URL);
  url.searchParams.set('email', normalizedEmail);
  url.searchParams.set('token', linkToken);
  return url.toString();
}

/** What the dashboard needs to send the recovery email itself with @emailjs/browser. */
export interface BrowserEmailDispatch {
  serviceId: string;
  templateId: string;
  publicKey: string;
  templateParams: EmailTemplateParams;
}

export function isResetDeliveryAvailable(): boolean {
  return isEmailDeliveryConfigured || env.NODE_ENV !== 'production';
}

export function isBrowserTransport(): boolean {
  return env.PASSWORD_RESET_EMAIL_TRANSPORT === 'browser';
}

/**
 * Template params for the recovery email. Every key is always present (empty when unused) so
 * one EmailJS template can use `{{#reset_link}}...{{/reset_link}}` sections for any mode.
 */
function buildResetTemplateParams(
  recipient: ResetEmailRecipient,
  secrets: Pick<IssuedResetSecrets, 'linkToken' | 'code'>,
): EmailTemplateParams {
  const resetLink = secrets.linkToken ? buildResetLink(recipient.email, secrets.linkToken) : '';
  const resetCode = secrets.code ?? '';

  return {
    // Short aliases match the minimal template ({{email}} as To Email, {{link}}, {{code}}).
    email: recipient.email,
    link: resetLink,
    code: resetCode,
    to_email: recipient.email,
    to_name: recipient.name?.trim() || recipient.email,
    app_name: env.APP_NAME,
    reset_link: resetLink,
    reset_code: resetCode,
    expires_in_minutes: String(env.PASSWORD_RESET_TTL_MINUTES),
  };
}

function logDevelopmentRecovery(email: string, params: EmailTemplateParams): void {
  // Development only: isResetDeliveryAvailable() blocks this path in production.
  console.warn(
    `passwordReset: EmailJS not configured; development recovery for ${email}` +
      `${params.link ? ` link=${params.link}` : ''}${params.code ? ` code=${params.code}` : ''}`,
  );
}

/** Server transport: sends the recovery email with the EmailJS Node.js SDK. */
export async function deliverResetEmail(
  recipient: ResetEmailRecipient,
  secrets: Pick<IssuedResetSecrets, 'linkToken' | 'code'>,
): Promise<void> {
  const params = buildResetTemplateParams(recipient, secrets);

  if (!isEmailDeliveryConfigured) {
    logDevelopmentRecovery(recipient.email, params);
    return;
  }

  await sendEmailJsTemplate(env.EMAILJS_PASSWORD_RESET_TEMPLATE_ID, params);
}

/**
 * Browser transport: returns what @emailjs/browser needs to send the email. Only the public
 * key is exposed; the private key is never included. Returns null when EmailJS is not
 * configured (development), after logging the recovery like the server transport does.
 */
export function buildBrowserEmailDispatch(
  recipient: ResetEmailRecipient,
  secrets: Pick<IssuedResetSecrets, 'linkToken' | 'code'>,
): BrowserEmailDispatch | null {
  const params = buildResetTemplateParams(recipient, secrets);

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
