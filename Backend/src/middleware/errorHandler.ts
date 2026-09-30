import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

/**
 * Terminal error handler.
 *
 * Client errors and server errors are logged differently on purpose. A 4xx is the API doing its
 * job - a rejected batch, an oversized body - and printing a stack trace for each one buries the
 * 5xx that actually needs attention. Only 5xx gets the stack.
 */
export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  const statusCode = payloadTooLarge(err) ? 413 : err.statusCode || err.status || 500;

  if (statusCode >= 500) {
    console.error('Unhandled Error:', err);
  } else {
    console.warn(`${req.method} ${req.originalUrl} -> ${statusCode}: ${err.message}`);
  }

  // body-parser's PayloadTooLargeError message ("request entity too large") says nothing about
  // what the limit is or who should change what. The agent logs this response body verbatim, so
  // make it the whole diagnosis.
  if (payloadTooLarge(err)) {
    return res.status(413).json({
      error: 'Request body is larger than this server accepts',
      limitBytes: err.limit,
      receivedBytes: err.length ?? err.received,
      // The agent halves its batch and retries on a 413 rather than treating it as fatal, so
      // this is recoverable without operator action. Raising JSON_BODY_LIMIT is the fix only if
      // a *single* event cannot fit.
      remedy: 'Send fewer events per request, or raise JSON_BODY_LIMIT on the server.',
    });
  }

  res.status(statusCode).json({
    error: err.message || 'Internal Server Error',
    ...(env.NODE_ENV === 'development' && statusCode >= 500 ? { stack: err.stack } : {}),
  });
};

function payloadTooLarge(err: any): boolean {
  return err?.type === 'entity.too.large' || err?.statusCode === 413 || err?.status === 413;
}
