/**
 * Backend-side port of Agent.Collectors.Attendance's AttendanceEngine + AttendanceSummaryBuilder
 * (see `Windows Software/src/Agent.Collectors/Attendance/`). The Agent sends raw state-transition
 * events, not computed "hours worked" (spec §4.1.1) — this derives daily summaries from them the
 * same way the client would, so dashboard numbers agree with what the client displays locally.
 */

export type AttendanceEventType = 'Login' | 'Logout' | 'Lock' | 'Unlock' | 'SleepStart' | 'SleepEnd' | 'IdleStart' | 'IdleEnd';

export interface AttendanceRawEvent {
  clientEventId: string;
  sessionId: number;
  userSid: string;
  machineId: string;
  eventType: AttendanceEventType;
  occurredAtUtc: Date;
}

interface TimeInterval {
  start: Date;
  end: Date;
}

export interface DailyAttendanceSummary {
  userSid: string;
  machineId: string;
  dateUtc: string; // yyyy-MM-dd
  loggedInSeconds: number;
  nonWorkingSeconds: number;
  activeSeconds: number;
  firstLoginUtc: Date;
  lastActivityUtc: Date;
}

const NON_WORKING_START: Partial<Record<AttendanceEventType, AttendanceEventType>> = {
  Lock: 'Unlock',
  SleepStart: 'SleepEnd',
  IdleStart: 'IdleEnd',
};
const NON_WORKING_END_TO_START: Record<string, AttendanceEventType> = {
  Unlock: 'Lock',
  SleepEnd: 'SleepStart',
  IdleEnd: 'IdleStart',
};

const EVENT_ORDERING_PRIORITY: Record<AttendanceEventType, number> = {
  Login: 0,
  Logout: 2,
  Lock: 1,
  Unlock: 1,
  SleepStart: 1,
  SleepEnd: 1,
  IdleStart: 1,
  IdleEnd: 1,
};

interface SessionRecord {
  sessionId: number;
  userSid: string;
  machineId: string;
  startUtc: Date;
  endUtc: Date | null;
  nonWorkingIntervals: TimeInterval[];
}

class SessionBuilder {
  private closedNonWorking: TimeInterval[] = [];
  private activeSources = new Set<AttendanceEventType>();
  private openNonWorkingStart: Date | null = null;

  constructor(private readonly loginEvent: AttendanceRawEvent) {}

  openNonWorking(source: AttendanceEventType, atUtc: Date) {
    if (!this.activeSources.has(source)) {
      this.activeSources.add(source);
      if (this.activeSources.size === 1) {
        this.openNonWorkingStart = atUtc;
      }
    }
  }

  closeNonWorking(source: AttendanceEventType, atUtc: Date) {
    if (!this.activeSources.delete(source) || this.activeSources.size > 0) {
      return;
    }
    if (this.openNonWorkingStart && atUtc > this.openNonWorkingStart) {
      this.closedNonWorking.push({ start: this.openNonWorkingStart, end: atUtc });
    }
    this.openNonWorkingStart = null;
  }

  private forceCloseAll(atUtc: Date) {
    if (this.openNonWorkingStart && atUtc > this.openNonWorkingStart) {
      this.closedNonWorking.push({ start: this.openNonWorkingStart, end: atUtc });
    }
    this.openNonWorkingStart = null;
    this.activeSources.clear();
  }

  close(endUtc: Date): SessionRecord {
    this.forceCloseAll(endUtc);
    return {
      sessionId: this.loginEvent.sessionId,
      userSid: this.loginEvent.userSid,
      machineId: this.loginEvent.machineId,
      startUtc: this.loginEvent.occurredAtUtc,
      endUtc,
      nonWorkingIntervals: this.closedNonWorking,
    };
  }

  asOpen(): SessionRecord {
    return {
      sessionId: this.loginEvent.sessionId,
      userSid: this.loginEvent.userSid,
      machineId: this.loginEvent.machineId,
      startUtc: this.loginEvent.occurredAtUtc,
      endUtc: null,
      nonWorkingIntervals: this.closedNonWorking,
    };
  }
}

function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  const ordered = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  if (ordered.length === 0) return [];

  const merged: TimeInterval[] = [];
  let current = ordered[0]!;
  for (let i = 1; i < ordered.length; i++) {
    const next = ordered[i]!;
    if (next.start.getTime() <= current.end.getTime()) {
      if (next.end.getTime() > current.end.getTime()) {
        current = { start: current.start, end: next.end };
      }
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

function totalDurationSeconds(intervals: TimeInterval[]): number {
  return mergeIntervals(intervals).reduce((sum, i) => sum + (i.end.getTime() - i.start.getTime()) / 1000, 0);
}

/** Builds closed/open sessions per Windows logon session, per (userSid, machineId). Mirrors AttendanceEngine.BuildSessions. */
function buildSessions(events: AttendanceRawEvent[], nowUtcForOpenSessions: Date): SessionRecord[] {
  const bySession = new Map<string, AttendanceRawEvent[]>();
  for (const evt of events) {
    const key = `${evt.machineId}::${evt.userSid}::${evt.sessionId}`;
    const list = bySession.get(key);
    if (list) list.push(evt);
    else bySession.set(key, [evt]);
  }

  const sessions: SessionRecord[] = [];

  for (const group of bySession.values()) {
    const ordered = [...group].sort((a, b) => {
      const t = a.occurredAtUtc.getTime() - b.occurredAtUtc.getTime();
      if (t !== 0) return t;
      const p = EVENT_ORDERING_PRIORITY[a.eventType] - EVENT_ORDERING_PRIORITY[b.eventType];
      if (p !== 0) return p;
      return a.clientEventId < b.clientEventId ? -1 : a.clientEventId > b.clientEventId ? 1 : 0;
    });

    let current: SessionBuilder | null = null;

    for (const evt of ordered) {
      switch (evt.eventType) {
        case 'Login':
          if (current) sessions.push(current.close(evt.occurredAtUtc));
          current = new SessionBuilder(evt);
          break;
        case 'Logout':
          if (current) {
            sessions.push(current.close(evt.occurredAtUtc));
            current = null;
          }
          break;
        case 'Lock':
        case 'IdleStart':
        case 'SleepStart':
          current?.openNonWorking(evt.eventType, evt.occurredAtUtc);
          break;
        case 'Unlock':
        case 'IdleEnd':
        case 'SleepEnd':
          current?.closeNonWorking(NON_WORKING_END_TO_START[evt.eventType]!, evt.occurredAtUtc);
          break;
      }
    }

    if (current) {
      sessions.push(nowUtcForOpenSessions ? current.close(nowUtcForOpenSessions) : current.asOpen());
    }
  }

  return sessions.sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
}

function splitAtUtcMidnight(start: Date, end: Date): TimeInterval[] {
  const slices: TimeInterval[] = [];
  let cursor = start;
  while (cursor < end) {
    const nextMidnight = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1));
    const sliceEnd = nextMidnight < end ? nextMidnight : end;
    slices.push({ start: cursor, end: sliceEnd });
    cursor = sliceEnd;
  }
  return slices;
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Mirrors AttendanceSummaryBuilder.BuildDailySummaries: splits sessions at UTC midnight, merges non-working intervals, subtracts. */
export function buildDailyAttendanceSummaries(events: AttendanceRawEvent[], nowUtcForOpenSessions: Date): DailyAttendanceSummary[] {
  const sessions = buildSessions(events, nowUtcForOpenSessions);

  interface DaySlice {
    dateKey: string;
    userSid: string;
    machineId: string;
    loggedIn: TimeInterval;
    nonWorking: TimeInterval[];
  }

  const daySlices: DaySlice[] = [];

  for (const session of sessions) {
    const effectiveEnd = session.endUtc ?? nowUtcForOpenSessions;
    if (effectiveEnd <= session.startUtc) continue;

    for (const slice of splitAtUtcMidnight(session.startUtc, effectiveEnd)) {
      const nonWorkingInSlice = session.nonWorkingIntervals
        .filter((nw) => nw.start < slice.end && nw.end > slice.start)
        .map((nw) => ({
          start: nw.start > slice.start ? nw.start : slice.start,
          end: nw.end < slice.end ? nw.end : slice.end,
        }));

      daySlices.push({
        dateKey: toDateKey(slice.start),
        userSid: session.userSid,
        machineId: session.machineId,
        loggedIn: slice,
        nonWorking: nonWorkingInSlice,
      });
    }
  }

  const grouped = new Map<string, DaySlice[]>();
  for (const slice of daySlices) {
    const key = `${slice.userSid}::${slice.machineId}::${slice.dateKey}`;
    const list = grouped.get(key);
    if (list) list.push(slice);
    else grouped.set(key, [slice]);
  }

  const summaries: DailyAttendanceSummary[] = [];
  for (const [, slices] of grouped) {
    const loggedInSeconds = slices.reduce((sum, s) => sum + (s.loggedIn.end.getTime() - s.loggedIn.start.getTime()) / 1000, 0);
    const nonWorkingSeconds = totalDurationSeconds(slices.flatMap((s) => s.nonWorking));
    const activeSeconds = Math.max(0, loggedInSeconds - nonWorkingSeconds);

    summaries.push({
      userSid: slices[0]!.userSid,
      machineId: slices[0]!.machineId,
      dateUtc: slices[0]!.dateKey,
      loggedInSeconds,
      nonWorkingSeconds,
      activeSeconds,
      firstLoginUtc: new Date(Math.min(...slices.map((s) => s.loggedIn.start.getTime()))),
      lastActivityUtc: new Date(Math.max(...slices.map((s) => s.loggedIn.end.getTime()))),
    });
  }

  return summaries.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
}
