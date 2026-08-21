'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { IconButton } from '@/components/ui';

type Theme = 'light' | 'dark';

/**
 * Light/dark toggle. Writes the choice to localStorage, which the inline script in the root
 * layout reads on the next load to avoid a flash of the wrong theme.
 *
 * Renders a fixed-size placeholder until mounted: the server has no way to know the stored
 * preference, so rendering the real icon during SSR would guarantee a hydration mismatch.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const isDark = document.documentElement.classList.contains('dark');
    setTheme(isDark ? 'dark' : 'light');
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    localStorage.setItem('theme', next);
    setTheme(next);
  }

  if (theme === null) {
    return <span className="size-9" aria-hidden />;
  }

  return (
    <IconButton
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title="Toggle theme"
    >
      {theme === 'dark' ? (
        <Sun className="size-[18px]" strokeWidth={1.75} aria-hidden />
      ) : (
        <Moon className="size-[18px]" strokeWidth={1.75} aria-hidden />
      )}
    </IconButton>
  );
}
