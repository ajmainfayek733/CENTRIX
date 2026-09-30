"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { IconButton } from "@/components/ui";

type Theme = "light" | "dark";

function getSnapshot(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getServerSnapshot(): null {
  return null; // forces the placeholder on the server / during hydration
}

function subscribe(onStoreChange: () => void) {
  // Optional: react if something else mutates the class
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

/**
 * Light/dark toggle. Writes the choice to localStorage, which the inline script in the root
 * layout reads on the next load to avoid a flash of the wrong theme.
 *
 * Renders a fixed-size placeholder until mounted: the server has no way to know the stored
 * preference, so rendering the real icon during SSR would guarantee a hydration mismatch.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem("theme", next);
    // The MutationObserver (or the next render of useSyncExternalStore) will pick up the change
  }

  if (theme === null) {
    return <span className="size-9" aria-hidden />;
  }

  return (
    <IconButton
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title="Toggle theme"
    >
      {theme === "dark" ? (
        <Sun className="size-4.5" strokeWidth={1.75} aria-hidden />
      ) : (
        <Moon className="size-4.5" strokeWidth={1.75} aria-hidden />
      )}
    </IconButton>
  );
}
