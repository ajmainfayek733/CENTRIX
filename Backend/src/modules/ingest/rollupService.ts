import { Prisma, ProductivityTag } from "@prisma/client";
import { isActiveType, isIdleType } from "../report/activityClassification";

/**
 * Ingest-time aggregation into daily_activity_rollups.
 *
 * WHY THIS EXISTS: the read path used to sum activity_sessions across a date range on every
 * dashboard load. At 30 devices that is tolerable; at 100+ it is millions of ten-second app
 * switches re-scanned by every manager who opens the overview. Aggregating once, as the data
 * arrives, turns that into one row per employee per day.
 *
 * EXACTLY-ONCE IS THE WHOLE GAME. These counters are incremented, never recomputed, so counting
 * one event twice corrupts the day permanently and silently. Two things guarantee it does not:
 *
 *   1. Batch-level idempotency (ingest_batches) short-circuits a replayed batch before any of
 *      this runs.
 *   2. Callers pass only events that were genuinely newly inserted - the ones that survived the
 *      pre-filter against existing clientEventIds. A row already in the database contributed to
 *      the rollup when it first arrived, so re-sending it must contribute nothing.
 *
 * The upsert is raw SQL rather than Prisma's, because first/last-activity need LEAST/GREATEST
 * against the values already stored, which the query builder cannot express. It is one statement
 * per (day, device, employee) group, and a batch almost always covers a single day.
 */

/** One day's contribution from one batch. All fields are deltas, never absolutes. */
export interface RollupDelta {
  activeSeconds: number;
  idleSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  blacklistedSeconds: number;
  keyCount: number;
  mouseCount: number;
  activitySessionCount: number;
  browserVisitCount: number;
  usbEventCount: number;
  alertCount: number;
  firstActivityAt: Date | null;
  lastActivityAt: Date | null;
}

interface BrowserDomainDelta {
  durationSeconds: number;
  visitCount: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  blacklistedSeconds: number;
}

interface ActivityMetricDailyDelta {
  sampleCount: number;
  keyCount: number;
  mouseCount: number;
  mouseLeftKeyCount: number;
  mouseRightKeyCount: number;
  mouseMiddleKeyCount: number;
  mouseOtherKeyCount: number;
}

interface ActivityApplicationDailyDelta {
  durationSeconds: number;
  sessionCount: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  blacklistedSeconds: number;
}

export function emptyDelta(): RollupDelta {
  return {
    activeSeconds: 0,
    idleSeconds: 0,
    productiveSeconds: 0,
    unproductiveSeconds: 0,
    neutralSeconds: 0,
    blacklistedSeconds: 0,
    keyCount: 0,
    mouseCount: 0,
    activitySessionCount: 0,
    browserVisitCount: 0,
    usbEventCount: 0,
    alertCount: 0,
    firstActivityAt: null,
    lastActivityAt: null,
  };
}

/**
 * Accumulates deltas keyed by work date (YYYY-MM-DD).
 *
 * A batch normally covers one day but can straddle midnight, and an agent coming back from a
 * long offline stretch can carry a week - so the unit of accumulation is the day, not the batch.
 */
export class RollupAccumulator {
  private readonly byDate = new Map<string, RollupDelta>();
  private readonly browserByDateAndDomain = new Map<string, Map<string, BrowserDomainDelta>>();
  private readonly metricByDate = new Map<string, ActivityMetricDailyDelta>();
  private readonly applicationByDateAndName = new Map<
    string,
    Map<string, ActivityApplicationDailyDelta>
  >();

  private forDate(workDate: string): RollupDelta {
    let delta = this.byDate.get(workDate);
    if (!delta) {
      delta = emptyDelta();
      this.byDate.set(workDate, delta);
    }
    return delta;
  }

  /** Widens the day's activity span. Null timestamps are ignored rather than treated as epoch. */
  private touchSpan(delta: RollupDelta, start: Date, end: Date) {
    if (!delta.firstActivityAt || start < delta.firstActivityAt) delta.firstActivityAt = start;
    if (!delta.lastActivityAt || end > delta.lastActivityAt) delta.lastActivityAt = end;
  }

  addActivitySession(
    workDate: string,
    type: Prisma.ActivitySessionCreateManyInput["type"],
    tag: ProductivityTag,
    durationSeconds: number,
    startTime: Date,
    endTime: Date,
  ) {
    const delta = this.forDate(workDate);
    delta.activitySessionCount += 1;
    this.touchSpan(delta, startTime, endTime);

    if (isActiveType(type)) {
      delta.activeSeconds += durationSeconds;

      switch (tag) {
        case ProductivityTag.Productive:
          delta.productiveSeconds += durationSeconds;
          break;
        case ProductivityTag.Unproductive:
          delta.unproductiveSeconds += durationSeconds;
          break;
        case ProductivityTag.Blacklisted:
          delta.blacklistedSeconds += durationSeconds;
          break;
        default:
          delta.neutralSeconds += durationSeconds;
      }
    } else if (isIdleType(type)) {
      delta.idleSeconds += durationSeconds;
    }
  }

  addApplicationSummary(
    workDate: string,
    appName: string | null,
    tag: ProductivityTag,
    durationSeconds: number,
  ) {
    const name = appName ?? "__unknown_application__";
    let applications = this.applicationByDateAndName.get(workDate);
    if (!applications) {
      applications = new Map();
      this.applicationByDateAndName.set(workDate, applications);
    }
    const application = applications.get(name) ?? {
      durationSeconds: 0,
      sessionCount: 0,
      productiveSeconds: 0,
      unproductiveSeconds: 0,
      neutralSeconds: 0,
      blacklistedSeconds: 0,
    };
    application.durationSeconds += durationSeconds;
    application.sessionCount += 1;
    switch (tag) {
      case ProductivityTag.Productive:
        application.productiveSeconds += durationSeconds;
        break;
      case ProductivityTag.Unproductive:
        application.unproductiveSeconds += durationSeconds;
        break;
      case ProductivityTag.Blacklisted:
        application.blacklistedSeconds += durationSeconds;
        break;
      default:
        application.neutralSeconds += durationSeconds;
    }
    applications.set(name, application);
  }

  addActivityMetric(
    workDate: string,
    keyCount: number,
    mouseCount: number,
    mouseLeftKeyCount: number,
    mouseRightKeyCount: number,
    mouseMiddleKeyCount: number,
    mouseOtherKeyCount: number,
    windowEnd: Date,
  ) {
    const delta = this.forDate(workDate);
    delta.keyCount += keyCount;
    delta.mouseCount += mouseCount;
    this.touchSpan(delta, windowEnd, windowEnd);

    const metric = this.metricByDate.get(workDate) ?? {
      sampleCount: 0,
      keyCount: 0,
      mouseCount: 0,
      mouseLeftKeyCount: 0,
      mouseRightKeyCount: 0,
      mouseMiddleKeyCount: 0,
      mouseOtherKeyCount: 0,
    };
    metric.sampleCount += 1;
    metric.keyCount += keyCount;
    metric.mouseCount += mouseCount;
    metric.mouseLeftKeyCount += mouseLeftKeyCount;
    metric.mouseRightKeyCount += mouseRightKeyCount;
    metric.mouseMiddleKeyCount += mouseMiddleKeyCount;
    metric.mouseOtherKeyCount += mouseOtherKeyCount;
    this.metricByDate.set(workDate, metric);
  }

  addBrowserVisit(
    workDate: string,
    domain: string,
    tag: ProductivityTag,
    durationSeconds: number,
    startTime: Date,
    endTime: Date,
  ) {
    // Browser time is deliberately NOT added to activeSeconds: the browser was already the
    // foreground application for that interval, and its ActivitySession has counted it. Adding
    // it again would report more working time than the day contains.
    const delta = this.forDate(workDate);
    delta.browserVisitCount += 1;
    this.touchSpan(delta, startTime, endTime);

    let domains = this.browserByDateAndDomain.get(workDate);
    if (!domains) {
      domains = new Map();
      this.browserByDateAndDomain.set(workDate, domains);
    }
    const domainDelta = domains.get(domain) ?? {
      durationSeconds: 0,
      visitCount: 0,
      productiveSeconds: 0,
      unproductiveSeconds: 0,
      neutralSeconds: 0,
      blacklistedSeconds: 0,
    };
    domainDelta.durationSeconds += durationSeconds;
    domainDelta.visitCount += 1;
    switch (tag) {
      case ProductivityTag.Productive:
        domainDelta.productiveSeconds += durationSeconds;
        break;
      case ProductivityTag.Unproductive:
        domainDelta.unproductiveSeconds += durationSeconds;
        break;
      case ProductivityTag.Blacklisted:
        domainDelta.blacklistedSeconds += durationSeconds;
        break;
      default:
        domainDelta.neutralSeconds += durationSeconds;
    }
    domains.set(domain, domainDelta);
  }

  addUsbEvent(workDate: string, eventTime: Date) {
    const delta = this.forDate(workDate);
    delta.usbEventCount += 1;
    this.touchSpan(delta, eventTime, eventTime);
  }

  addAlert(workDate: string, triggeredAt: Date) {
    const delta = this.forDate(workDate);
    delta.alertCount += 1;
    this.touchSpan(delta, triggeredAt, triggeredAt);
  }

  /** Ensures a day has a row even when nothing measurable happened (e.g. attendance only). */
  touchDate(workDate: string) {
    this.forDate(workDate);
  }

  get isEmpty(): boolean {
    return this.byDate.size === 0;
  }

  entries(): [string, RollupDelta][] {
    return [...this.byDate.entries()];
  }

  browserDomainEntries(): [string, string, BrowserDomainDelta][] {
    return [...this.browserByDateAndDomain.entries()].flatMap(([workDate, domains]) =>
      [...domains.entries()].map(([domain, delta]): [string, string, BrowserDomainDelta] => [
        workDate,
        domain,
        delta,
      ]),
    );
  }

  activityMetricEntries(): [string, ActivityMetricDailyDelta][] {
    return [...this.metricByDate.entries()];
  }

  applicationEntries(): [string, string, ActivityApplicationDailyDelta][] {
    return [...this.applicationByDateAndName.entries()].flatMap(([workDate, applications]) =>
      [...applications.entries()].map(
        ([appName, delta]): [string, string, ActivityApplicationDailyDelta] => [
          workDate,
          appName,
          delta,
        ],
      ),
    );
  }

  /** The days this batch touched, for the realtime hint sent to dashboards. */
  dates(): string[] {
    return [...this.byDate.keys()];
  }

  /**
   * Everything this batch added, flattened across days.
   *
   * Pushed to dashboards so they can move their totals without re-querying. Deliberately a
   * DELTA rather than the new absolute value: a dashboard is showing a range that may span many
   * days and devices, and it has no way to fold one row's absolute total into that. Adding what
   * just arrived is something it can always do correctly, whatever range it is displaying.
   */
  total(): RollupDelta {
    const combined = emptyDelta();

    for (const delta of this.byDate.values()) {
      combined.activeSeconds += delta.activeSeconds;
      combined.idleSeconds += delta.idleSeconds;
      combined.productiveSeconds += delta.productiveSeconds;
      combined.unproductiveSeconds += delta.unproductiveSeconds;
      combined.neutralSeconds += delta.neutralSeconds;
      combined.blacklistedSeconds += delta.blacklistedSeconds;
      combined.keyCount += delta.keyCount;
      combined.mouseCount += delta.mouseCount;
      combined.activitySessionCount += delta.activitySessionCount;
      combined.browserVisitCount += delta.browserVisitCount;
      combined.usbEventCount += delta.usbEventCount;
      combined.alertCount += delta.alertCount;
    }

    return combined;
  }
}

/**
 * Applies the accumulated deltas.
 *
 * Runs on the caller's transaction client so the rollup commits with the events that produced
 * it. If they could commit separately, a crash between them would leave a day permanently
 * over- or under-counted with no way to notice.
 */
export async function applyRollup(
  tx: Prisma.TransactionClient,
  scope: { organizationId: string; employeeId: string; deviceId: string },
  accumulator: RollupAccumulator,
): Promise<void> {
  for (const [workDate, delta] of accumulator.entries()) {
    // ON CONFLICT targets the (workDate, deviceId, employeeId) unique index. Two batches from
    // the same device never run concurrently, but a device reassigned mid-batch would still be
    // handled correctly: it is a different employee, so a different row.
    await tx.$executeRaw`
      INSERT INTO daily_activity_rollups (
        id, "organizationId", "employeeId", "deviceId", "workDate",
        "activeSeconds", "idleSeconds", "productiveSeconds", "unproductiveSeconds",
        "neutralSeconds", "blacklistedSeconds", "keyCount", "mouseCount",
        "activitySessionCount", "browserVisitCount", "usbEventCount", "alertCount",
        "firstActivityAt", "lastActivityAt", "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid(), ${scope.organizationId}, ${scope.employeeId}, ${scope.deviceId},
        ${workDate}::date,
        ${delta.activeSeconds}, ${delta.idleSeconds}, ${delta.productiveSeconds},
        ${delta.unproductiveSeconds}, ${delta.neutralSeconds}, ${delta.blacklistedSeconds},
        ${delta.keyCount}, ${delta.mouseCount},
        ${delta.activitySessionCount}, ${delta.browserVisitCount},
        ${delta.usbEventCount}, ${delta.alertCount},
        ${delta.firstActivityAt}, ${delta.lastActivityAt}, NOW(), NOW()
      )
      ON CONFLICT ("workDate", "deviceId", "employeeId") DO UPDATE SET
        "activeSeconds"        = daily_activity_rollups."activeSeconds"        + EXCLUDED."activeSeconds",
        "idleSeconds"          = daily_activity_rollups."idleSeconds"          + EXCLUDED."idleSeconds",
        "productiveSeconds"    = daily_activity_rollups."productiveSeconds"    + EXCLUDED."productiveSeconds",
        "unproductiveSeconds"  = daily_activity_rollups."unproductiveSeconds"  + EXCLUDED."unproductiveSeconds",
        "neutralSeconds"       = daily_activity_rollups."neutralSeconds"       + EXCLUDED."neutralSeconds",
        "blacklistedSeconds"   = daily_activity_rollups."blacklistedSeconds"   + EXCLUDED."blacklistedSeconds",
        "keyCount"             = daily_activity_rollups."keyCount"             + EXCLUDED."keyCount",
        "mouseCount"           = daily_activity_rollups."mouseCount"           + EXCLUDED."mouseCount",
        "activitySessionCount" = daily_activity_rollups."activitySessionCount" + EXCLUDED."activitySessionCount",
        "browserVisitCount"    = daily_activity_rollups."browserVisitCount"    + EXCLUDED."browserVisitCount",
        "usbEventCount"        = daily_activity_rollups."usbEventCount"        + EXCLUDED."usbEventCount",
        "alertCount"           = daily_activity_rollups."alertCount"           + EXCLUDED."alertCount",
        -- LEAST/GREATEST ignore NULLs, so a day that has never seen a timestamp still adopts
        -- the first one that arrives instead of staying null.
        "firstActivityAt"      = LEAST(daily_activity_rollups."firstActivityAt", EXCLUDED."firstActivityAt"),
        "lastActivityAt"       = GREATEST(daily_activity_rollups."lastActivityAt", EXCLUDED."lastActivityAt"),
        "updatedAt"            = NOW()
    `;
  }

  for (const [workDate, domain, delta] of accumulator.browserDomainEntries()) {
    // The current day is intentionally left in browser_activity. Reports use that raw data for
    // exact audits; the scheduler folds completed days after the configured work window.
    if (workDate >= utcWorkDate(new Date())) continue;

    await tx.$executeRaw`
      INSERT INTO browser_daily_summaries (
        id, "organizationId", "employeeId", "workDate", "domain",
        "durationSeconds", "visitCount", "productiveSeconds", "unproductiveSeconds",
        "neutralSeconds", "blacklistedSeconds", "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid(), ${scope.organizationId}, ${scope.employeeId}, ${workDate}::date, ${domain},
        ${delta.durationSeconds}, ${delta.visitCount}, ${delta.productiveSeconds},
        ${delta.unproductiveSeconds}, ${delta.neutralSeconds}, ${delta.blacklistedSeconds}, NOW(), NOW()
      )
      ON CONFLICT ("workDate", "employeeId", "domain") DO UPDATE SET
        "durationSeconds"     = browser_daily_summaries."durationSeconds" + EXCLUDED."durationSeconds",
        "visitCount"          = browser_daily_summaries."visitCount" + EXCLUDED."visitCount",
        "productiveSeconds"   = browser_daily_summaries."productiveSeconds" + EXCLUDED."productiveSeconds",
        "unproductiveSeconds" = browser_daily_summaries."unproductiveSeconds" + EXCLUDED."unproductiveSeconds",
        "neutralSeconds"      = browser_daily_summaries."neutralSeconds" + EXCLUDED."neutralSeconds",
        "blacklistedSeconds"  = browser_daily_summaries."blacklistedSeconds" + EXCLUDED."blacklistedSeconds",
        "updatedAt"           = NOW()
    `;
  }

  for (const [workDate, delta] of accumulator.activityMetricEntries()) {
    if (workDate >= utcWorkDate(new Date())) continue;

    await tx.$executeRaw`
      INSERT INTO activity_metric_daily_summaries (
        id, "organizationId", "employeeId", "workDate", "sampleCount", "keyCount", "mouseCount",
        "mouseLeftKeyCount", "mouseRightKeyCount", "mouseMiddleKeyCount", "mouseOtherKeyCount",
        "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid(), ${scope.organizationId}, ${scope.employeeId}, ${workDate}::date,
        ${delta.sampleCount}, ${delta.keyCount}, ${delta.mouseCount}, ${delta.mouseLeftKeyCount},
        ${delta.mouseRightKeyCount}, ${delta.mouseMiddleKeyCount}, ${delta.mouseOtherKeyCount}, NOW(), NOW()
      )
      ON CONFLICT ("workDate", "employeeId") DO UPDATE SET
        "sampleCount"         = activity_metric_daily_summaries."sampleCount" + EXCLUDED."sampleCount",
        "keyCount"            = activity_metric_daily_summaries."keyCount" + EXCLUDED."keyCount",
        "mouseCount"          = activity_metric_daily_summaries."mouseCount" + EXCLUDED."mouseCount",
        "mouseLeftKeyCount"   = activity_metric_daily_summaries."mouseLeftKeyCount" + EXCLUDED."mouseLeftKeyCount",
        "mouseRightKeyCount"  = activity_metric_daily_summaries."mouseRightKeyCount" + EXCLUDED."mouseRightKeyCount",
        "mouseMiddleKeyCount" = activity_metric_daily_summaries."mouseMiddleKeyCount" + EXCLUDED."mouseMiddleKeyCount",
        "mouseOtherKeyCount"  = activity_metric_daily_summaries."mouseOtherKeyCount" + EXCLUDED."mouseOtherKeyCount",
        "updatedAt"           = NOW()
    `;
  }

  for (const [workDate, appName, delta] of accumulator.applicationEntries()) {
    if (workDate >= utcWorkDate(new Date())) continue;

    await tx.$executeRaw`
      INSERT INTO activity_session_daily_summaries (
        id, "organizationId", "employeeId", "workDate", "appName", "durationSeconds", "sessionCount",
        "productiveSeconds", "unproductiveSeconds", "neutralSeconds", "blacklistedSeconds",
        "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid(), ${scope.organizationId}, ${scope.employeeId}, ${workDate}::date, ${appName},
        ${delta.durationSeconds}, ${delta.sessionCount}, ${delta.productiveSeconds},
        ${delta.unproductiveSeconds}, ${delta.neutralSeconds}, ${delta.blacklistedSeconds}, NOW(), NOW()
      )
      ON CONFLICT ("workDate", "employeeId", "appName") DO UPDATE SET
        "durationSeconds"     = activity_session_daily_summaries."durationSeconds" + EXCLUDED."durationSeconds",
        "sessionCount"        = activity_session_daily_summaries."sessionCount" + EXCLUDED."sessionCount",
        "productiveSeconds"   = activity_session_daily_summaries."productiveSeconds" + EXCLUDED."productiveSeconds",
        "unproductiveSeconds" = activity_session_daily_summaries."unproductiveSeconds" + EXCLUDED."unproductiveSeconds",
        "neutralSeconds"      = activity_session_daily_summaries."neutralSeconds" + EXCLUDED."neutralSeconds",
        "blacklistedSeconds"  = activity_session_daily_summaries."blacklistedSeconds" + EXCLUDED."blacklistedSeconds",
        "updatedAt"           = NOW()
    `;
  }
}

/** Formats a timestamp as the UTC calendar date, the fallback when no local work date is known. */
export function utcWorkDate(timestamp: Date): string {
  return timestamp.toISOString().slice(0, "YYYY-MM-DD".length);
}
