import { LogoutSource, Prisma, SessionEndReason } from '@prisma/client';
import { env } from '../../config/env';

/**
 * Closes attendance sessions that nothing on the workstation is ever going to close.
 *
 * WHY THE SERVER HAS TO DO THIS AT ALL
 *
 * Every path that stamps a `logoutTime` runs on the workstation: the agent observes the lock,
 * the suspend or the shutdown and writes it, and anything it missed is repaired by its own
 * recovery pass (TelemetryQueue.RecoverOpenAttendanceSessions) the next time the service starts.
 * Both require the machine to still be there.
 *
 * Under scheduled load shedding it is not. Power drops mid-session, the agent gets no notice and
 * writes nothing, and the recovery pass only runs if and when that machine boots again with the
 * agent installed - which may be after the weekend, after a reimage, or never. Until then the row
 * sits with `logoutTime = NULL`, which the reporting layer has to read as "we do not know", so the
 * day has a login and no logout and the employee's attendance is unusable for payroll. That is
 * the state this repairs, and it is repairable only here: the server is the one participant that
 * is still running.
 *
 * WHAT IT WRITES
 *
 * Never `now`. A session that ended when the power went is not still running until a sweep
 * notices, and stamping the discovery time would inflate the day by however long the outage
 * lasted. It writes the last instant the server has evidence of presence, which is the same
 * quantity the agent's own recovery pass infers, from the same agent-sourced numbers.
 *
 * WHY IT IS ALWAYS CORRECTABLE
 *
 * Every close here is an inference, so it is marked `logoutSource = Server` and the ingest path
 * lets a later agent report overwrite it - including one that says the session was still open,
 * which reopens the row. A laptop running on battery through an outage is exactly that case: the
 * server sees silence and infers an end, the agent comes back with the truth, and the truth wins.
 * Only `logoutSource = Agent` is final.
 */

const MS_PER_SECOND = 1_000;

/** IN () list size for the evidence lookups. Bounds parameter count per statement. */
const LOOKUP_CHUNK_SIZE = 200;

/** Updates per statement group, so a large backlog is not one round trip per row. */
const UPDATE_CHUNK_SIZE = 50;

/** What one sweep did, by the rule that fired. */
export interface ReapSummary {
  /** Closed because a later session on the same workstation proves this one had ended. */
  superseded: number;
  /** Closed because the workstation went silent - the load-shedding case. */
  abandoned: number;
  /** Closed because no session may stay open past the ceiling, however healthy the device. */
  expired: number;
}

interface OpenSession {
  sessionId: string;
  deviceId: string;
  userSid: string;
  loginTime: Date;
  totalActiveSeconds: number;
  totalIdleSeconds: number;
}

interface Closure {
  sessionId: string;
  logoutTime: Date;
  endReason: SessionEndReason;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** The later of two instants, either of which may be missing. */
function latest(left: Date | null, right: Date | null): Date | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

/**
 * The last instant this session can be shown to have been alive.
 *
 * Three sources, best of:
 *
 *   - `loginTime + totalActiveSeconds + totalIdleSeconds`. The agent's own accounting of the
 *     seconds it observed inside this session, so it advances only while somebody was there.
 *   - the end of the latest activity-log row attributed to the session.
 *   - the end of the latest keyboard/mouse counter window attributed to the session.
 *
 * All three are workstation clocks. `updatedAt` is deliberately not among them: it records when
 * the row reached *this* server, and a queue drained after an outage writes rows hours after the
 * presence they describe - taking it would report an employee as present throughout the blackout.
 *
 * Clamped into `[loginTime, now]`: a workstation clock that is wrong, or was corrected mid-session,
 * must not be able to produce a logout before the login or one in the future.
 */
function lastEvidenceAt(session: OpenSession, activityEnd: Date | null, metricEnd: Date | null, now: Date): Date {
  const observedSeconds = session.totalActiveSeconds + session.totalIdleSeconds;
  const observedUntil = new Date(session.loginTime.getTime() + observedSeconds * MS_PER_SECOND);

  const evidence = latest(latest(observedUntil, activityEnd), metricEnd) ?? session.loginTime;

  if (evidence > now) return now;
  if (evidence < session.loginTime) return session.loginTime;
  return evidence;
}

/**
 * One sweep. Runs inside the caller's transaction so the whole decision - read the open rows,
 * gather the evidence, write the closures - commits or rolls back together.
 *
 * Each write is a guarded `updateMany` on `logoutTime IS NULL` rather than an `update` by id, so
 * an agent that closed the session for real between the read and the write keeps its own answer:
 * the statement matches nothing and the inference is discarded. That guard is the same one ingest
 * uses, and it is the reason the two can run concurrently without a lock between them.
 *
 * `revision` is deliberately left alone. It numbers the workstation's own snapshots, and raising
 * it here would make the next genuine agent report look stale against a number the agent never
 * issued - the row would then reject the very evidence that is supposed to correct this guess.
 */
export async function closeAbandonedSessions(tx: Prisma.TransactionClient, now = new Date()): Promise<ReapSummary> {
  const summary: ReapSummary = { superseded: 0, abandoned: 0, expired: 0 };

  const open = await tx.attendanceSession.findMany({
    where: { logoutTime: null },
    // Oldest first: if a backlog exceeds one sweep's budget, the rows that have been wrong the
    // longest are the ones fixed first.
    orderBy: { loginTime: 'asc' },
    take: env.ATTENDANCE_REAP_MAX_SESSIONS,
    select: {
      sessionId: true,
      deviceId: true,
      userSid: true,
      loginTime: true,
      totalActiveSeconds: true,
      totalIdleSeconds: true,
    },
  });

  if (open.length === 0) return summary;

  const [successors, activityEnds, metricEnds, deviceLastSeen] = await Promise.all([
    successorLogins(tx, open),
    latestActivityEnds(tx, open),
    latestMetricEnds(tx, open),
    lastSeenByDevice(tx, open),
  ]);

  const abandonAfterMs = env.ATTENDANCE_ABANDON_AFTER_SECONDS * MS_PER_SECOND;
  const maxOpenMs = env.ATTENDANCE_MAX_OPEN_SECONDS * MS_PER_SECOND;

  const closures: Closure[] = [];

  for (const session of open) {
    const evidence = lastEvidenceAt(
      session,
      activityEnds.get(session.sessionId) ?? null,
      metricEnds.get(session.sessionId) ?? null,
      now
    );

    // Rule 1 - superseded. A later login by the same user on the same workstation is proof the
    // earlier stretch of presence is over, whatever the device is doing now. No waiting: this is
    // evidence, not a timeout, and it is the common case after an outage because the machine
    // comes back and opens a fresh session while the dead one is still on file.
    const successor = successors.get(session.sessionId);
    if (successor !== undefined) {
      // The session cannot have outlived the login that replaced it, however far the evidence
      // appears to reach - a clock adjustment could otherwise put it past the successor.
      const logoutTime = evidence < successor ? evidence : successor;
      closures.push({ sessionId: session.sessionId, logoutTime, endReason: SessionEndReason.Recovered });
      summary.superseded += 1;
      continue;
    }

    const evidenceAgeMs = now.getTime() - evidence.getTime();

    // Rule 2 - the workstation went dark and stayed dark. Both halves are required: a device that
    // is still checking in has a live agent that will close its own session, and a row whose
    // totals are still advancing belongs to somebody at their desk. Only when the server has
    // heard nothing from either does it conclude the machine is gone.
    const lastSeen = deviceLastSeen.get(session.deviceId) ?? null;
    const deviceSilentMs = lastSeen === null ? Number.POSITIVE_INFINITY : now.getTime() - lastSeen.getTime();

    if (deviceSilentMs > abandonAfterMs && evidenceAgeMs > abandonAfterMs) {
      closures.push({ sessionId: session.sessionId, logoutTime: evidence, endReason: SessionEndReason.PowerLoss });
      summary.abandoned += 1;
      continue;
    }

    // Rule 3 - the ceiling. Reached only by a row that dodged both rules above: a device that
    // still reports but whose agent never rotated this session. Left open it would count as
    // presence indefinitely and report the employee as permanently signed in.
    if (evidenceAgeMs > maxOpenMs) {
      closures.push({ sessionId: session.sessionId, logoutTime: evidence, endReason: SessionEndReason.Recovered });
      summary.expired += 1;
    }
  }

  for (const group of chunk(closures, UPDATE_CHUNK_SIZE)) {
    await Promise.all(
      group.map((closure) =>
        tx.attendanceSession.updateMany({
          where: { sessionId: closure.sessionId, logoutTime: null },
          data: {
            logoutTime: closure.logoutTime,
            endReason: closure.endReason,
            logoutSource: LogoutSource.Server,
          },
        })
      )
    );
  }

  return summary;
}

/** Key for the successor lookup: one stretch of presence follows another per user per machine. */
function successorKey(session: { deviceId: string; userSid: string }): string {
  return `${session.deviceId} ${session.userSid}`;
}

/**
 * For each open session, keyed by its own session id, the earliest login that came after it on
 * the same workstation for the same user - or nothing, if it is the latest.
 *
 * Fetched as one range query per sweep rather than a correlated lookup per row: the rows of
 * interest all start after the oldest open session, and a fleet's worth of them is a small read.
 * Keyed per session rather than per workstation because several sessions on one machine can be
 * open at once - after a run of outages they form a chain, and each is superseded by the next,
 * not all of them by the last.
 */
async function successorLogins(tx: Prisma.TransactionClient, open: OpenSession[]): Promise<Map<string, Date>> {
  const oldestLogin = open.reduce((earliest, s) => (s.loginTime < earliest ? s.loginTime : earliest), open[0].loginTime);

  const candidates = await tx.attendanceSession.findMany({
    where: {
      deviceId: { in: [...new Set(open.map((s) => s.deviceId))] },
      userSid: { in: [...new Set(open.map((s) => s.userSid))] },
      loginTime: { gt: oldestLogin },
    },
    select: { deviceId: true, userSid: true, loginTime: true },
  });

  // Ascending, so the first entry seen per open session is the earliest login after it. Sorting
  // once here is what keeps the per-session step below a lookup rather than a scan.
  candidates.sort((left, right) => left.loginTime.getTime() - right.loginTime.getTime());

  const byKey = new Map<string, Date[]>();
  for (const candidate of candidates) {
    const key = successorKey(candidate);
    const logins = byKey.get(key);
    if (logins === undefined) byKey.set(key, [candidate.loginTime]);
    else logins.push(candidate.loginTime);
  }

  const successors = new Map<string, Date>();
  for (const session of open) {
    const next = byKey.get(successorKey(session))?.find((login) => login > session.loginTime);
    if (next !== undefined) successors.set(session.sessionId, next);
  }

  return successors;
}

/** Latest activity-log end time per session id. */
async function latestActivityEnds(tx: Prisma.TransactionClient, open: OpenSession[]): Promise<Map<string, Date>> {
  const ends = new Map<string, Date>();

  for (const ids of chunk(open.map((s) => s.sessionId), LOOKUP_CHUNK_SIZE)) {
    const rows = await tx.activitySession.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: ids } },
      _max: { endTime: true },
    });

    for (const row of rows) {
      if (row._max.endTime !== null) ends.set(row.sessionId, row._max.endTime);
    }
  }

  return ends;
}

/** Latest input-counter window end per session id. */
async function latestMetricEnds(tx: Prisma.TransactionClient, open: OpenSession[]): Promise<Map<string, Date>> {
  const ends = new Map<string, Date>();

  for (const ids of chunk(open.map((s) => s.sessionId), LOOKUP_CHUNK_SIZE)) {
    const rows = await tx.activityMetric.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: ids } },
      _max: { windowEndUtc: true },
    });

    for (const row of rows) {
      if (row._max.windowEndUtc !== null) ends.set(row.sessionId, row._max.windowEndUtc);
    }
  }

  return ends;
}

/** Liveness of every workstation holding an open session. */
async function lastSeenByDevice(
  tx: Prisma.TransactionClient,
  open: OpenSession[]
): Promise<Map<string, Date | null>> {
  const devices = await tx.device.findMany({
    where: { id: { in: [...new Set(open.map((s) => s.deviceId))] } },
    select: { id: true, lastSeen: true },
  });

  return new Map(devices.map((device) => [device.id, device.lastSeen]));
}

/** Formats a sweep for the scheduler log, or null when it found nothing to do. */
export function describeReap(summary: ReapSummary): string | null {
  const total = summary.superseded + summary.abandoned + summary.expired;
  if (total === 0) return null;

  return (
    `closed ${total} abandoned attendance session(s): ` +
    `${summary.superseded} superseded, ${summary.abandoned} device offline, ${summary.expired} past the open-session ceiling`
  );
}
