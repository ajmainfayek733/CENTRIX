import { CategoryTarget, ProductivityTag } from "@prisma/client";
import { prisma } from "../../config/db";

export interface CategoryMatch {
  tag: ProductivityTag;
  isBlacklisted: boolean;
}

export interface CategoryRule {
  pattern: string;
  target: CategoryTarget;
  tag: ProductivityTag;
  isBlacklisted: boolean;
  departmentId: string | null;
}

interface CachedRules {
  rules: CategoryRule[];
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
  private generation = new Map<string, number>();

  private async rulesFor(organizationId: string): Promise<CategoryRule[]> {
    const cached = this.cache.get(organizationId);
    if (cached && cached.expiresAt > Date.now()) return cached.rules;

    const startedAt = this.generation.get(organizationId) ?? 0;

    const rows = await prisma.category.findMany({
      where: { organizationId },
      select: { pattern: true, target: true, tag: true, isBlacklisted: true, departmentId: true },
    });
    const rules: CategoryRule[] = rows.map((r) => ({
      ...r,
      pattern: r.pattern.toLowerCase(),
    }));

    if ((this.generation.get(organizationId) ?? 0) === startedAt) {
      this.cache.set(organizationId, { rules, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    return rules;
  }

  /** Drop the cached rules for an org - call after any write from the settings screen. */
  invalidate(organizationId: string) {
    this.generation.set(organizationId, (this.generation.get(organizationId) ?? 0) + 1);
    this.cache.delete(organizationId);
  }

  /**
   * Returns the merged effective rules for a specific department (or org-wide if departmentId is null).
   * Department rules override org-wide rules with the same target and pattern.
   */
  async getEffectiveRules(
    organizationId: string,
    departmentId?: string | null,
  ): Promise<
    Array<{ pattern: string; target: CategoryTarget; tag: ProductivityTag; isBlacklisted: boolean }>
  > {
    const allRules = await this.rulesFor(organizationId);
    if (allRules.length === 0) return [];

    const ruleMap = new Map<string, CategoryRule>();

    // 1. First add org-wide rules (departmentId === null)
    for (const rule of allRules) {
      if (rule.departmentId === null) {
        ruleMap.set(`${rule.target}:${rule.pattern}`, rule);
      }
    }

    // 2. If a department is specified, override with department-specific rules
    if (departmentId) {
      for (const rule of allRules) {
        if (rule.departmentId === departmentId) {
          ruleMap.set(`${rule.target}:${rule.pattern}`, rule);
        }
      }
    }

    return [...ruleMap.values()].map(({ pattern, target, tag, isBlacklisted }) => ({
      pattern,
      target,
      tag,
      isBlacklisted,
    }));
  }

  /**
   * Categorize a foreground application.
   *
   * Priority:
   * 1. Department-specific Blacklist rule
   * 2. Org-wide Blacklist rule
   * 3. Department-specific rule (Productive / Unproductive / Neutral)
   * 4. Org-wide rule (Productive / Unproductive / Neutral)
   */
  async categorizeApp(
    organizationId: string,
    appName?: string | null,
    processName?: string | null,
    executablePath?: string | null,
    departmentId?: string | null,
  ): Promise<CategoryMatch | null> {
    const rules = await this.rulesFor(organizationId);
    if (rules.length === 0) return null;

    const haystacks = [appName, processName, executablePath]
      .filter((v): v is string => !!v)
      .map((v) => v.toLowerCase());
    if (haystacks.length === 0) return null;

    // Filter relevant rules (department-specific for this department, or org-wide)
    const appRules = rules.filter(
      (r) =>
        r.target === CategoryTarget.Application &&
        (r.departmentId === null || (departmentId && r.departmentId === departmentId)),
    );

    if (appRules.length === 0) return null;

    // Pass 1: Check Blacklists (Department blacklist first, then Org blacklist)
    if (departmentId) {
      for (const rule of appRules) {
        if (rule.departmentId === departmentId && rule.isBlacklisted) {
          if (haystacks.some((h) => h.includes(rule.pattern))) {
            return { tag: ProductivityTag.Blacklisted, isBlacklisted: true };
          }
        }
      }
    }
    for (const rule of appRules) {
      if (rule.departmentId === null && rule.isBlacklisted) {
        if (haystacks.some((h) => h.includes(rule.pattern))) {
          return { tag: ProductivityTag.Blacklisted, isBlacklisted: true };
        }
      }
    }

    // Pass 2: Department-specific non-blacklisted rules
    if (departmentId) {
      for (const rule of appRules) {
        if (rule.departmentId === departmentId && !rule.isBlacklisted) {
          if (haystacks.some((h) => h.includes(rule.pattern))) {
            return { tag: rule.tag, isBlacklisted: false };
          }
        }
      }
    }

    // Pass 3: Org-wide non-blacklisted rules
    for (const rule of appRules) {
      if (rule.departmentId === null && !rule.isBlacklisted) {
        if (haystacks.some((h) => h.includes(rule.pattern))) {
          return { tag: rule.tag, isBlacklisted: false };
        }
      }
    }

    return null;
  }

  /**
   * Categorize a visited domain.
   *
   * Priority:
   * 1. Department-specific Blacklist rule
   * 2. Org-wide Blacklist rule
   * 3. Department-specific rule (Productive / Unproductive / Neutral)
   * 4. Org-wide rule (Productive / Unproductive / Neutral)
   */
  async categorizeDomain(
    organizationId: string,
    domain?: string | null,
    departmentId?: string | null,
  ): Promise<CategoryMatch | null> {
    const rules = await this.rulesFor(organizationId);
    if (rules.length === 0 || !domain) return null;

    const host = domain.toLowerCase();
    const domainRules = rules.filter(
      (r) =>
        r.target === CategoryTarget.Domain &&
        (r.departmentId === null || (departmentId && r.departmentId === departmentId)),
    );

    if (domainRules.length === 0) return null;

    const matchesDomain = (pattern: string) => host === pattern || host.endsWith(`.${pattern}`);

    // Pass 1: Check Blacklists (Department blacklist first, then Org blacklist)
    if (departmentId) {
      for (const rule of domainRules) {
        if (rule.departmentId === departmentId && rule.isBlacklisted) {
          if (matchesDomain(rule.pattern)) {
            return { tag: ProductivityTag.Blacklisted, isBlacklisted: true };
          }
        }
      }
    }
    for (const rule of domainRules) {
      if (rule.departmentId === null && rule.isBlacklisted) {
        if (matchesDomain(rule.pattern)) {
          return { tag: ProductivityTag.Blacklisted, isBlacklisted: true };
        }
      }
    }

    // Pass 2: Department-specific non-blacklisted rules
    if (departmentId) {
      for (const rule of domainRules) {
        if (rule.departmentId === departmentId && !rule.isBlacklisted) {
          if (matchesDomain(rule.pattern)) {
            return { tag: rule.tag, isBlacklisted: false };
          }
        }
      }
    }

    // Pass 3: Org-wide non-blacklisted rules
    for (const rule of domainRules) {
      if (rule.departmentId === null && !rule.isBlacklisted) {
        if (matchesDomain(rule.pattern)) {
          return { tag: rule.tag, isBlacklisted: false };
        }
      }
    }

    return null;
  }
}

export const categoryService = new CategoryService();
