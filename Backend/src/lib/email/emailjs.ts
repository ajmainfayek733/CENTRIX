import emailjs, { EmailJSResponseStatus } from '@emailjs/nodejs';
import { env, isEmailDeliveryConfigured } from '../../config/env';

/** Values EmailJS substitutes into `{{placeholders}}`. Kept flat and string-typed on purpose. */
export type EmailTemplateParams = Readonly<Record<string, string>>;

const MAX_ERROR_BODY_CHARS = 500;
/** EmailJS status when "Allow EmailJS API for non-browser applications" is disabled. */
const HTTP_FORBIDDEN = 403;

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EmailDeliveryError';
  }
}

interface EmailJsCredentials {
  serviceId: string;
  publicKey: string;
  privateKey: string;
}

function credentials(): EmailJsCredentials {
  if (
    !isEmailDeliveryConfigured ||
    !env.EMAILJS_SERVICE_ID ||
    !env.EMAILJS_PUBLIC_KEY ||
    !env.EMAILJS_PRIVATE_KEY
  ) {
    throw new EmailDeliveryError('EmailJS is not configured');
  }
  return {
    serviceId: env.EMAILJS_SERVICE_ID,
    publicKey: env.EMAILJS_PUBLIC_KEY,
    privateKey: env.EMAILJS_PRIVATE_KEY,
  };
}

/** The SDK has no timeout of its own; bound it so a hung provider cannot pile up requests. */
function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new EmailDeliveryError(`EmailJS did not respond within ${timeoutMs} ms`)),
      timeoutMs,
    );
    timer.unref();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function toDeliveryError(error: unknown): EmailDeliveryError {
  if (error instanceof EmailDeliveryError) return error;

  // The SDK rejects with a status object, not an Error, for every non-200 response.
  if (error instanceof EmailJSResponseStatus) {
    const detail = (error.text ?? '').slice(0, MAX_ERROR_BODY_CHARS);
    const hint =
      error.status === HTTP_FORBIDDEN
        ? ' Enable "Allow EmailJS API for non-browser applications" in EmailJS Account > Security.'
        : '';
    return new EmailDeliveryError(
      `EmailJS rejected the request with status ${error.status}: ${detail}${hint}`,
      error.status,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new EmailDeliveryError(`EmailJS request failed: ${message}`, undefined, { cause: error });
}

/**
 * Sends one templated email through the official EmailJS Node.js SDK.
 *
 * Credentials are passed per call rather than through `emailjs.init`, so no process-wide SDK
 * state is mutated. Server-side sends authenticate with the private key and require the
 * account's non-browser API access to be enabled.
 */
export async function sendEmailJsTemplate(
  templateId: string,
  templateParams: EmailTemplateParams,
): Promise<void> {
  const { serviceId, publicKey, privateKey } = credentials();

  try {
    await withTimeout(
      emailjs.send(serviceId, templateId, { ...templateParams }, { publicKey, privateKey }),
      env.EMAILJS_TIMEOUT_MS,
    );
  } catch (error) {
    throw toDeliveryError(error);
  }
}
