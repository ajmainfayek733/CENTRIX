'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { UserRole } from '@/lib/session';

const LINKS = [
  { href: '/overview', label: 'Overview' },
  { href: '/employees', label: 'Employees' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/devices', label: 'Devices' },
  // Only a super_admin can change what the agents do; the backend enforces the same rule.
  { href: '/settings', label: 'Settings', adminOnly: true },
] as const;

export function NavLinks({ role }: { role: UserRole }) {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 overflow-x-auto">
      {LINKS.filter((link) => !('adminOnly' in link && link.adminOnly) || role === 'super_admin').map(
        (link) => {
          const isActive = pathname === link.href || pathname.startsWith(`${link.href}/`);

          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-surface-muted font-medium text-text-primary'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {link.label}
            </Link>
          );
        }
      )}
    </nav>
  );
}
