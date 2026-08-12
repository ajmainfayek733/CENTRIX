import { prisma } from './db';

/**
 * Resolves the organization a dashboard request belongs to.
 *
 * The deployment is single-tenant: one organization row, created at setup, owning every
 * employee, device and policy. Dashboard users are not scoped to an organization in the schema,
 * so read-path code that needs one (page size from policy, realtime rooms) resolves it here
 * rather than each caller inventing its own `findFirst`.
 *
 * When multi-tenancy arrives this is the single place that changes: it becomes a lookup from the
 * authenticated user, and every caller already asks the right question.
 *
 * Cached because it is consulted on effectively every dashboard request and the answer changes
 * at most once in the life of a deployment. The TTL exists only so a freshly provisioned
 * organization is picked up without a restart.
 */
const CACHE_TTL_MS = 60_000;

let cachedId: string | null = null;
let cachedAt = 0;

export class NoOrganizationError extends Error {
  statusCode = 503;
  constructor() {
    super('No organization has been provisioned yet');
  }
}

export async function currentOrganizationId(): Promise<string> {
  if (cachedId && Date.now() - cachedAt < CACHE_TTL_MS) return cachedId;

  const organization = await prisma.organization.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  if (!organization) throw new NoOrganizationError();

  cachedId = organization.id;
  cachedAt = Date.now();
  return cachedId;
}

/** Clears the cache. Called after provisioning so the new organization is visible immediately. */
export function forgetCurrentOrganization(): void {
  cachedId = null;
  cachedAt = 0;
}
