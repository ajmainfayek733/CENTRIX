import { env, isEmailDeliveryConfigured } from '../../config/env';

/** Values EmailJS substitutes into `{{placeholders}}`. Kept flat and string-typed on purpose. */
export type EmailTemplateParams = Readonly<Record<string, string>>;

const MAX_ERROR_BODY_CHARS = 500;

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

/**
 * Sends one templated email through the EmailJS REST API.
 *
 * Server-side calls authenticate with the private key (`accessToken`); the public key alone is
 * only accepted from browsers. The request is bounded by EMAILJS_TIMEOUT_MS so a slow provider
 * cannot pin sockets indefinitely.
 */
export async function sendEmailJsTemplate(
  templateId: string,
  templateParams: EmailTemplateParams,
): Promise<void> {
  const { serviceId, publicKey, privateKey } = credentials();

  let response: Response;
  try {
    response = await fetch(env.EMAILJS_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service_id: serviceId,
        template_id: templateId,
        user_id: publicKey,
        accessToken: privateKey,
        template_params: templateParams,
      }),
      signal: AbortSignal.timeout(env.EMAILJS_TIMEOUT_MS),
    });
  } catch (error) {
    throw new EmailDeliveryError('EmailJS request failed before a response was received', undefined, {
      cause: error,
    });
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY_CHARS);
    throw new EmailDeliveryError(
      `EmailJS rejected the request with status ${response.status}: ${detail}`,
      response.status,
    );
  }
}
