"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid,
  Users,
  Building2,
  CalendarDays,
  ChartColumn,
  Monitor,
  Bell,
  FileText,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/session";

/**
 * Icons are decorative and marked aria-hidden: each one sits beside its own label, so a reader
 * that announced both would say "Overview Overview". They are never the only signal - the
 * horizontal variant keeps its text label too, rather than collapsing to icons on small screens
 * where a bare glyph is hardest to interpret.
 */
const LINKS: readonly {
  href: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  /** Laid out from the blueprint but not yet wired to an endpoint - see the note below. */
  template?: boolean;
}[] = [
  { href: "/overview", label: "Overview", icon: LayoutGrid },
  { href: "/employees", label: "Employees", icon: Users },
  { href: "/departments", label: "Departments", icon: Building2 },
  { href: "/attendance", label: "Attendance", icon: CalendarDays },
  { href: "/performance", label: "Performance", icon: ChartColumn },
  { href: "/devices", label: "Devices", icon: Monitor },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/reports", label: "Reports", icon: FileText },
  // Only a super_admin can change what the agents do; the backend enforces the same rule.
  { href: "/settings", label: "Settings", icon: Settings, adminOnly: true },
];

export function NavLinks({
  role,
  orientation = "vertical",
}: {
  role: UserRole;
  orientation?: "vertical" | "horizontal";
}) {
  const pathname = usePathname();
  const isVertical = orientation === "vertical";

  return (
    <nav
      className={cn(
        "flex items-center",
        isVertical ? "flex-col gap-[3px]" : "gap-1 overflow-x-auto",
      )}
    >
      {LINKS.filter((link) => !link.adminOnly || role === "super_admin").map((link) => {
        const isActive = pathname === link.href || pathname.startsWith(`${link.href}/`);
        const Icon = link.icon;

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex items-center gap-[11px] whitespace-nowrap rounded-md text-[13.5px] font-medium transition-colors",
              isVertical ? "w-full px-[13px] py-2.5" : "px-2.5 py-1.5",
              isActive
                ? "bg-brand-soft text-brand"
                : "text-text-secondary hover:bg-brand-soft/60 hover:text-text-primary",
            )}
          >
            <Icon
              className={cn("size-[18px] shrink-0", isActive ? "opacity-100" : "opacity-85")}
              strokeWidth={1.75}
              aria-hidden
            />
            {link.label}
            {/*
              A visible marker, not just a tooltip: these screens are laid out but carry no live
              data, and on a monitoring tool an operator has to be able to tell that from the
              navigation rather than after reading a screen of placeholders. Dropped in the
              compact bar, where there is no room for it.
            */}
            {link.template && isVertical && (
              <span
                className="ml-auto rounded-full bg-surface-muted px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-text-tertiary"
                title="Laid out from the design blueprint; not yet connected to the API"
              >
                WIP
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
