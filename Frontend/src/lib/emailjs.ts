import { EmailJSResponseStatus, send } from '@emailjs/browser';

/**
 * Browser-side EmailJS delivery for password recovery.
 *
 * Used only when the backend runs with PASSWORD_RESET_EMAIL_TRANSPORT=browser. The backend
 * decides the service, template, public key, and template params; this module only validates
 * that payload and hands it to the official @emailjs/browser SDK. No EmailJS credential is
 * configured in the frontend, so there is a single source of truth.
 */

export interface EmailDispatch {
  serviceId: string;
  templateId: string;
  publicKey: string;
  templateParams: Record<string, string>;
}

/** EmailJS status when the template, service, or recipient is rejected. */
const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_MANY_REQUESTS = 429;
const SEND_FAILED_MESSAGE = 'The recovery email could not be sent. Try again shortly.';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Narrows an untrusted API payload; returns null for anything malformed. */
export function parseEmailDispatch(value: unknown): EmailDispatch | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const params = candidate.templateParams;

  if (
    !isNonEmptyString(candidate.serviceId) ||
    !isNonEmptyString(candidate.templateId) ||
    !isNonEmptyString(candidate.publicKey) ||
    !params ||
    typeof params !== 'object' ||
    Array.isArray(params)
  ) {
    return null;
  }

  const templateParams: Record<string, string> = {};
  for (const [key, paramValue] of Object.entries(params as Record<string, unknown>)) {
    if (typeof paramValue !== 'string') return null;
    templateParams[key] = paramValue;
  }

  return {
    serviceId: candidate.serviceId,
    templateId: candidate.templateId,
    publicKey: candidate.publicKey,
    templateParams,
  };
}

/** Maps an SDK rejection to a message fit for the form. */
function describeSendFailure(error: unknown): string {
  if (error instanceof EmailJSResponseStatus) {
    if (error.status === HTTP_TOO_MANY_REQUESTS) {
      return 'Too many emails were sent recently. Wait a moment and try again.';
    }
    if (error.status >= HTTP_BAD_REQUEST && error.text) {
      return `${SEND_FAILED_MESSAGE} (${error.text})`;
    }
  }
  return SEND_FAILED_MESSAGE;
}

export class EmailSendError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EmailSendError';
  }
}

/**
 * Sends the recovery email with @emailjs/browser. The public key is passed per call instead of
 * through `init`, so no global SDK state outlives this request.
 */
export async function sendDispatchedEmail(dispatch: EmailDispatch): Promise<void> {
  try {
    await send(dispatch.serviceId, dispatch.templateId, dispatch.templateParams, {
      publicKey: dispatch.publicKey,
      // Refuse to run from headless browsers, a cheap guard against scripted abuse.
      blockHeadless: true,
    });
  } catch (error) {
    console.error('emailjs: recovery email send failed', error);
    throw new EmailSendError(describeSendFailure(error), { cause: error });
  }
}
