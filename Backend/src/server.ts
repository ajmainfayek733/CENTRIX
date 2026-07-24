import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './config/auth';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';

import ingestRoutes from './modules/ingest';
import authRoutes from './modules/auth';
import employeeRoutes from './modules/employee';
import reportRoutes from './modules/report';

const app = express();

// Security and Logging middleware
app.use(helmet());
app.use(
  cors({
    origin: [env.FRONTEND_URL],
    credentials: true,
  })
);
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// CRITICAL MOUNT ORDER (per Express.md §6):
// Better Auth handler reads raw request body directly and MUST be registered BEFORE express.json()
app.all('/api/auth/*splat', toNodeHandler(auth));


// Body parsing middleware for all subsequent standard API routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// Route Handlers following strict route prefixing specification (Express.md §1)
// Write Path for Unattended Windows Agents
app.use('/v1/ingest', ingestRoutes);
app.use('/api/agents', ingestRoutes); // Alias for agent compatibility
app.use('/api/v1', ingestRoutes);     // Agent API Contract endpoints


// Read Path for Human Dashboard (Managers, Admins, Auditors)
app.use('/v1/dashboard/auth', authRoutes);
app.use('/v1/dashboard/employees', employeeRoutes);
app.use('/v1/dashboard/reports', reportRoutes);

// Fallback legacy mount
app.use('/api/dashboard/auth', authRoutes);
app.use('/api/dashboard/employees', employeeRoutes);
app.use('/api/dashboard/reports', reportRoutes);

// Global Error Handler Middleware
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  console.log(`🚀 Monitoring Server active at http://localhost:${env.PORT}`);
  console.log(`🔒 Better Auth endpoints mounted at http://localhost:${env.PORT}/api/auth/*`);
});

export default app;