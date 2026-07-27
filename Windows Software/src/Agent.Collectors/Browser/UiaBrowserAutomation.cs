using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Windows.Automation;
using Microsoft.Extensions.Logging;

namespace Agent.Collectors.Browser;

/// <summary>
/// UI Automation only (no Chrome DevTools Protocol — CDP requires launching or attaching with a
/// remote-debugging port, which the spec's own strategy table doesn't require and which most
/// enterprise Chrome/Edge policies restrict). Locates the address bar with a positional
/// heuristic rather than a hardcoded per-browser AutomationId: Chromium/Firefox address bars
/// are Edit controls near the top of the window, but the exact AutomationId/Name strings are
/// version- and locale-dependent and are not something to hardcode without per-version
/// verification — this is a documented best-effort approach, not a guaranteed one.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class UiaBrowserAutomation(ILogger<UiaBrowserAutomation> logger) : IBrowserAutomation
{
    private const double AddressBarSearchBandHeight = 150;

    public string? TryExtractUrl(nint windowHandle, BrowserType browserType)
    {
        if (browserType == BrowserType.Unknown)
        {
            return null;
        }

        try
        {
            var window = AutomationElement.FromHandle(windowHandle);
            var addressBar = FindAddressBarElement(window);
            if (addressBar is null)
            {
                return null;
            }

            if (!addressBar.TryGetCurrentPattern(ValuePattern.Pattern, out var patternObj) || patternObj is not ValuePattern valuePattern)
            {
                return null;
            }

            var value = valuePattern.Current.Value;
            return string.IsNullOrWhiteSpace(value) ? null : value;
        }
        catch (ElementNotAvailableException)
        {
            // Window or control closed mid-read — an expected race, not a failure to log loudly.
            return null;
        }
        catch (COMException ex)
        {
            logger.LogDebug(ex, "UI Automation COM exception reading address bar for {BrowserType}.", browserType);
            return null;
        }
    }

    private static AutomationElement? FindAddressBarElement(AutomationElement window)
    {
        var condition = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit);
        var editControls = window.FindAll(TreeScope.Descendants, condition);
        var windowTop = window.Current.BoundingRectangle.Top;

        AutomationElement? best = null;
        var bestRelativeTop = double.MaxValue;

        foreach (AutomationElement candidate in editControls)
        {
            var rect = candidate.Current.BoundingRectangle;
            if (rect.IsEmpty)
            {
                continue;
            }

            var relativeTop = rect.Top - windowTop;
            if (relativeTop >= 0 && relativeTop < AddressBarSearchBandHeight && relativeTop < bestRelativeTop)
            {
                bestRelativeTop = relativeTop;
                best = candidate;
            }
        }

        return best;
    }
}
