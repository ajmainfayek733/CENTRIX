/**
 * Development seed: creates one organization (with its enrollment token and default policy),
 * a super_admin dashboard user, and a couple of employees.
 *
 * Run with: npm run seed
 *
 * Idempotent — re-running reuses the existing organization and user rather than failing, so it
 * is safe to call repeatedly while setting up a machine. Re-running does rotate the enrollment
 * token, which is deliberate: the token is only printed once, so a developer who lost it can
 * get a working one back.
 */
import { prisma } from '../src/config/db';
import { auth } from '../src/config/auth';
import { organizationService } from '../src/modules/organization/organizationService';
import { generateEnrollmentToken, hashEnrollmentToken } from '../src/utils/token';

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';
const ORG_NAME = process.env.SEED_ORG_NAME ?? 'Acme Corp';

async function main() {
  console.log('\nSeeding development data\n');

  // -- Organization ---------------------------------------------------------
  let organization = await prisma.organization.findFirst({ where: { name: ORG_NAME } });
  let enrollmentToken: string;

  if (organization) {
    enrollmentToken = generateEnrollmentToken();
    await prisma.organization.update({
      where: { id: organization.id },
      data: { enrollmentTokenHash: hashEnrollmentToken(enrollmentToken) },
    });
    await prisma.policy.upsert({
      where: { organizationId: organization.id },
      create: { organizationId: organization.id },
      update: {},
    });
    console.log(`  Organization  ${organization.name} (existing, enrollment token rotated)`);
  } else {
    const created = await organizationService.createOrganization({ name: ORG_NAME });
    enrollmentToken = created.enrollmentToken;
    organization = await prisma.organization.findUniqueOrThrow({ where: { id: created.id } });
    console.log(`  Organization  ${organization.name} (created)`);
  }

  // -- Dashboard admin ------------------------------------------------------
  const existingUser = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });

  if (existingUser) {
    console.log(`  Admin user    ${ADMIN_EMAIL} (existing, password unchanged)`);
  } else {
    // Through Better Auth rather than a raw insert, so the password is hashed with the same
    // algorithm sign-in verifies against.
    await auth.api.signUpEmail({
      body: {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        name: 'Seed Administrator',
        role: 'super_admin',
      },
    });

    // signUpEmail applies the default role; force super_admin explicitly so the seeded account
    // can actually reach the settings screen.
    await prisma.user.update({ where: { email: ADMIN_EMAIL }, data: { role: 'super_admin' } });
    console.log(`  Admin user    ${ADMIN_EMAIL} / ${ADMIN_PASSWORD} (created)`);
  }

  // -- Employees ------------------------------------------------------------
  const employees = [
    { name: 'Ada Lovelace', email: 'ada@example.com', department: 'Engineering' },
    { name: 'Grace Hopper', email: 'grace@example.com', department: 'Engineering' },
    { name: 'Jean Bartik', email: 'jean@example.com', department: 'Operations' },
  ];

  for (const employee of employees) {
    await prisma.employee.upsert({
      where: { email: employee.email },
      create: { ...employee, organizationId: organization.id },
      update: {},
    });
  }
  console.log(`  Employees     ${employees.length} ensured`);

  // -- Starter category rules ----------------------------------------------
  const rules = [
    { pattern: 'github.com', target: 'Domain' as const, tag: 'Productive' as const, isBlacklisted: false },
    { pattern: 'stackoverflow.com', target: 'Domain' as const, tag: 'Productive' as const, isBlacklisted: false },
    { pattern: 'facebook.com', target: 'Domain' as const, tag: 'Unproductive' as const, isBlacklisted: false },
    { pattern: 'code', target: 'Application' as const, tag: 'Productive' as const, isBlacklisted: false },
  ];

  for (const rule of rules) {
    await organizationService.upsertCategory(organization.id, rule);
  }
  console.log(`  Category rules ${rules.length} ensured`);

  console.log('\n  Agent enrollment token (store this — it is not recoverable):');
  console.log(`  ${enrollmentToken}\n`);
  console.log('  Install an agent with:');
  console.log(
    `  .\\Deploy-Agent.ps1 -Action Install -ServerUrl http://localhost:5000 -EnrollmentToken ${enrollmentToken} -AllowInsecureHttp\n`
  );
}

main()
  .catch((error) => {
    console.error('\nSeed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
