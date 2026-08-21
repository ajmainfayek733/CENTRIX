import { Search } from 'lucide-react';

/**
 * The blueprint's search pill.
 *
 * Disabled, because there is no search endpoint. An input that accepts typing and then does
 * nothing is the worst version of this control - it looks like the feature exists, swallows a
 * query, and returns silence. Disabled with the reason on it is at least honest about the state,
 * and it holds the layout so the topbar does not shift when search is wired up.
 *
 * `title` on the wrapper rather than the input: a disabled input does not receive pointer events
 * in most browsers, so a tooltip on it never appears.
 */
export function TopbarSearch() {
  return (
    <div
      className="glass-control hidden w-[300px] items-center gap-2 rounded-full px-[15px] py-2 opacity-70 lg:flex"
      title="Search is not available yet"
    >
      <Search className="size-4 shrink-0 text-text-tertiary" strokeWidth={2} aria-hidden />
      <input
        type="search"
        disabled
        aria-label="Search employees and devices (not available yet)"
        placeholder="Search employees, devices..."
        className="w-full min-w-0 border-none bg-transparent text-[13.5px] text-text-primary outline-none placeholder:text-text-tertiary disabled:cursor-not-allowed"
      />
    </div>
  );
}
