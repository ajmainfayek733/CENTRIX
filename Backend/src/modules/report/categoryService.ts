import { CategoryTarget, ProductivityTag } from '@prisma/client';
import { prisma } from '../../config/db';

export interface CategoryMatch {
  tag: ProductivityTag;
  isBlacklisted: boolean;
}

interface CachedRules {
  rules: Array<{ pattern: string; target: CategoryTarget; tag: ProductivityTag; isBlacklisted: boolean }>;
  expiresAt: number;
}

/**
 * Rules change from the settings screen at human speed but are consulted on every ingested
 * event, so they are cached briefly per organization. 30s is short enough that an admin sees
 * their edit take effect while they are still looking at the page.
 */
const CACHE_TTL_MS = 30_000;

export class CategoryService {
  private cache = new Map<string, CachedRules>();

  /**
   * Bumped on every invalidation, per organization.
   *
   * `rulesFor` reads the cache, awaits a query, then writes the cache — and an invalidation can
   * land in that gap. Without this counter the in-flight query's result (fetched *before* the
   * admin's write committed) is stored after the delete, and the stale rules then serve for the
   * full 30s TTL. The invalidation is silently undone.
   *
   * That is a real hazard once a fleet is ingesting continuously: with 30-100 agents pushing,
   * some request is almost always mid-fetch when an admin saves a rule, so the save appears to
   * do nothing for half a minute.
   */
  private generation = new Map<string, number>();

  private async rulesFor(organizationId: string) {
    const cached = this.cache.get(organizationId);
    if (cached && cached.expiresAt > Date.now()) return cached.rules;

    const startedAt = this.generation.get(organizationId) ?? 0;

    const rows = await prisma.category.findMany({
      where: { organizationId },
      select: { pattern: true, target: true, tag: true, isBlacklisted: true },
    });
    const rules = rows.map((r) => ({ ...r, pattern: r.pattern.toLowerCase() }));

    // Only publish if nothing invalidated while the query was in flight. If something did, this
    // result may predate the write, so it is returned to the caller but not cached — the next
    // request re-reads and sees the new rules.
    if ((this.generation.get(organizationId) ?? 0) === startedAt) {
      this.cache.set(organizationId, { rules, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    return rules;
  }

  /** Drop the cached rules for an org — call after any write from the settings screen. */
  invalidate(organizationId: string) {
    this.generation.set(organizationId, (this.generation.get(organizationId) ?? 0) + 1);
    this.cache.delete(organizationId);
  }

  /**
   * Categorize a foreground application. Matches against app name, process name and
   * executable path so a rule of "chrome" catches all three spellings.
   *
   * Blacklist wins over any other rule: a match that is blacklisted returns immediately
   * rather than being overridden by a later Productive rule.
   */
  async categorizeApp(
    organizationId: string,
    appName?: string | null,
    processName?: string | null,
    executablePath?: string | null
  ): Promise<CategoryMatch | null> {
    const rules = await this.rulesFor(organizationId);
    if (rules.length === 0) return null;

    const haystacks = [appName, processName, executablePath]
      .filter((v): v is string => !!v)
      .map((v) => v.toLowerCase());
    if (haystacks.length === 0) return null;

    let firstMatch: CategoryMatch | null = null;
    for (const rule of rules) {
      if (rule.target !== CategoryTarget.Application) continue;
      if (!haystacks.some((h) => h.includes(rule.pattern))) continue;
      if (rule.isBlacklisted) return { tag: ProductivityTag.Blacklisted, isBlacklisted: true };
      firstMatch ??= { tag: rule.tag, isBlacklisted: false };
    }
    return firstMatch;
  }

  /**
   * Categorize a visited domain. Matches on suffix so a rule of "facebook.com" also covers
   * "m.facebook.com", without "notfacebook.com" matching.
   */
  async categorizeDomain(organizationId: string, domain?: string | null): Promise<CategoryMatch | null> {
    const rules = await this.rulesFor(organizationId);
    if (rules.length === 0 || !domain) return null;

    const host = domain.toLowerCase();
    let firstMatch: CategoryMatch | null = null;
    for (const rule of rules) {
      if (rule.target !== CategoryTarget.Domain) continue;
      if (host !== rule.pattern && !host.endsWith(`.${rule.pattern}`)) continue;
      if (rule.isBlacklisted) return { tag: ProductivityTag.Blacklisted, isBlacklisted: true };
      firstMatch ??= { tag: rule.tag, isBlacklisted: false };
    }
    return firstMatch;
  }
}

export const categoryService = new CategoryService();
