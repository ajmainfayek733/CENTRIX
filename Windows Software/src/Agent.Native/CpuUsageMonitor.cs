using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.Versioning;

namespace Agent.Native;

public interface ICpuUsageMonitor
{
    /// <summary>Null when the counter is unavailable (disabled perf counter service, etc.) —
    /// the spec treats CPU as an optional signal, so callers must degrade gracefully.</summary>
    double? GetTotalProcessorUsagePercent();
}

/// <summary>
/// See Microsoft Learn: PerformanceCounter class
/// (https://learn.microsoft.com/dotnet/api/system.diagnostics.performancecounter). Wrapped
/// defensively since the "Processor Information" counter category can be missing or disabled
/// on locked-down enterprise images — this signal is explicitly optional per the Active/Idle spec.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class CpuUsageMonitor : ICpuUsageMonitor, IDisposable
{
    private readonly PerformanceCounter? _counter;

    public CpuUsageMonitor()
    {
        try
        {
            _counter = new PerformanceCounter("Processor Information", "% Processor Utility", "_Total");
            _counter.NextValue();
        }
        catch (Exception ex) when (ex is InvalidOperationException or UnauthorizedAccessException or Win32Exception)
        {
            _counter = null;
        }
    }

    public double? GetTotalProcessorUsagePercent()
    {
        if (_counter is null)
        {
            return null;
        }

        try
        {
            return _counter.NextValue();
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
        {
            return null;
        }
    }

    public void Dispose() => _counter?.Dispose();
}
