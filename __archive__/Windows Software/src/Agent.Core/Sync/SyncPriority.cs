namespace Agent.Core.Sync;

/// <summary>
/// Batched events wait for the next sync tick. Immediate events (alerts, USB) trigger an
/// out-of-cycle flush because they are low-volume and latency-sensitive.
/// </summary>
public enum SyncPriority
{
    Batched,
    Immediate
}
