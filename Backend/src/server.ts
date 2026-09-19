import { createServer } from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./config/auth";
import { prisma } from "./config/db";
import { env } from "./config/env";
import { errorHandler } from "./middleware/errorHandler";
import { initRealtime } from "./realtime";
import { defineJob, startMaintenanceJobs } from "./lib/scheduler";
import { closeAbandonedSessions, describeReap } from "./modules/attendance/attendanceReaper";
import { ingestService } from "./modules/ingest/ingestService";
import { runBrowserSummarySchedule } from "./modules/report/browserSummaryService";

import ingestRoutes from "./modules/ingest";
import authRoutes from "./modules/auth";
import employeeRoutes from "./modules/employee";
import reportRoutes from "./modules/report";
import organizationRoutes from "./modules/organization";

const app = express();

// Must be set before any middleware reads req.ip. Drives whether x-forwarded-for is believed at
// all - see TRUST_PROXY in config/env.ts. Numeric values mean "this many proxies in front".
const trustProxy = /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY;
app.set("trust proxy", trustProxy === "false" ? false : trustProxy === "true" ? true : trustProxy);

// Security and Logging middleware
app.use(helmet());
app.use(
  cors({
    origin: [env.FRONTEND_URL],
    credentials: true,
  }),
);
app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));

// CRITICAL MOUNT ORDER (per Docs/backend/README.md, "Request lifecycle"):
// Better Auth handler reads raw request body directly and MUST be registered BEFORE express.json()
app.all("/api/auth/{*any}", toNodeHandler(auth));

// Body parsing middleware for all subsequent standard API routes.
// The limit is raised from Express's 100kb default because agent event batches legitimately
// exceed it - see JSON_BODY_LIMIT in config/env.ts.
app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: env.JSON_BODY_LIMIT }));

/**
 * Health check - the availability oracle for anything that needs to know whether this server can
 * actually do work.
 *
 * It runs a real query rather than returning a constant. A process that is listening but cannot
 * reach Postgres serves 500s on every write, and a health check that answers "ok" for it is worse
 * than no health check: it tells the agent to push telemetry into a hole.
 *
 * This is deliberately the only thing the agent and any load balancer should trust for
 * availability. An open Socket.IO connection proves none of it - see src/realtime/events.ts.
 */
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: "ok",
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("health: database probe failed:", error);
    res.status(503).json({
      status: "unavailable",
      reason: "database unreachable",
      timestamp: new Date().toISOString(),
    });
  }
});

// Write path for the Windows Agent - exactly the surface documented in
// Docs/reference/agent-api.md (events/{channel}, policy, screenshots, consent).
app.use("/api/v1", ingestRoutes);

// Read/admin path for the human dashboard (managers, admins, auditors). Out of scope of the
// Agent API spec (section 1.1) - this is backend-owned surface.
app.use("/v1/dashboard/auth", authRoutes);
app.use("/v1/dashboard/organizations", organizationRoutes);
app.use("/v1/dashboard/employees", employeeRoutes);
app.use("/v1/dashboard/reports", reportRoutes);

// Global Error Handler Middleware
app.use(errorHandler);

// Socket.IO shares the Express port, so it needs the raw http.Server rather than the shorthand
// app.listen() returns. Signalling only - telemetry and policy still travel over the REST API
// above, which is the durable, acknowledged, idempotent path.
export const server = createServer(app);

export const io = initRealtime(server);

/**
 * Housekeeping the request path cannot do for itself.
 *
 * Attendance closure is the load-bearing one. An attendance row is closed by the workstation that
 * opened it, and a workstation that loses power closes nothing - so on a site with scheduled load
 * shedding the server is the only participant left able to finish those sessions. Without this the
 * rows stay open until that exact machine boots again, and every report covering the day reads a
 * login with no logout.
 */
startMaintenanceJobs([
  defineJob(
    "attendanceReap",
    env.ATTENDANCE_REAP_INTERVAL_SECONDS,
    env.ATTENDANCE_REAP_TIMEOUT_MS,
    async (tx) => describeReap(await closeAbandonedSessions(tx)),
  ),
  defineJob(
    "ingestBatchPrune",
    env.INGEST_BATCH_PRUNE_INTERVAL_SECONDS,
    env.INGEST_TRANSACTION_TIMEOUT_MS,
    async (tx) => {
      const pruned = await ingestService.pruneIngestBatches(tx);
      return pruned === 0 ? null : `pruned ${pruned} expired batch ledger row(s)`;
    },
  ),
  defineJob(
    "browserSummary",
    env.BROWSER_SUMMARY_JOB_INTERVAL_SECONDS,
    env.BROWSER_SUMMARY_JOB_TIMEOUT_MS,
    (tx) => runBrowserSummarySchedule(tx),
  ),
]);

server.listen(env.PORT, () => {
  console.log(` Monitoring Server active at http://localhost:${env.PORT}`);
  console.log(` Better Auth endpoints mounted at http://localhost:${env.PORT}/api/auth/*`);
  console.log(` Realtime signalling on /agents and /dashboard`);
});

export default app;
