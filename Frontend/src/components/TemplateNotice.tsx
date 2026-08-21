import { Notice } from '@/components/ui';

/**
 * Marks a screen that is laid out from the design blueprint but not yet wired to the API.
 *
 * Every figure under this banner is invented. On a workforce monitoring tool that matters more
 * than it would elsewhere: these screens carry attendance and productivity readings, and a
 * screenshot of one is exactly the kind of thing that ends up in a conversation about a real
 * person. So the placeholders name no real employee or department - they are A, B, C - and the
 * banner sits above the content rather than in a footnote.
 *
 * Delete this component's usage from a screen at the same commit that connects it to real data.
 */
export function TemplateNotice({ endpoint }: { endpoint: string }) {
  return (
    <Notice tone="warning">
      <span className="font-semibold text-text-primary">Sample layout - not live data.</span> Every
      figure and name on this screen is a placeholder. It is waiting on {endpoint}, which the API
      does not expose yet.
    </Notice>
  );
}
