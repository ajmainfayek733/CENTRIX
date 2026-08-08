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

  private async rulesFor(organizationId: string) {
    const cached = this.cache.get(organizationId);
    if (cached && cached.expiresAt > Date.now()) return cached.rules;

    const rows = await prisma.category.findMany({
      where: { organizationId },
      select: { pattern: true, target: true, tag: true, isBlacklisted: true },
    });
    const rules = rows.map((r) => ({ ...r, pattern: r.pattern.toLowerCase() }));
    this.cache.set(organizationId, { rules, expiresAt: Date.now() + CACHE_TTL_MS });
    return rules;
  }

  /** Drop the cached rules for an org — call after any write from the settings screen. */
  invalidate(organizationId: string) {
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
