import { Request, Response, NextFunction } from 'express';

interface RateLimitStore {
  [ip: string]: { count: number; resetTime: number };
}

export const rateLimiter = (maxRequests = 100, windowMs = 60 * 1000) => {
  // Scoped per rateLimiter(...) call, not module-wide — otherwise every route sharing this
  // middleware (login at 10/min, ingest at 200/min, ...) would collide on the same IP counter
  // and get checked against whichever limit happened to run, instead of its own.
  const store: RateLimitStore = {};

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
    const now = Date.now();

    if (!store[ip] || now > store[ip].resetTime) {
      store[ip] = { count: 1, resetTime: now + windowMs };
      return next();
    }

    store[ip].count += 1;

    if (store[ip].count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }

    next();
  };
};
