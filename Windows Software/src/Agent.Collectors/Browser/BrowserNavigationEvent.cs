using Agent.Core.Sync;

namespace Agent.Collectors.Browser;

public sealed record BrowserNavigationEvent : ISyncableEvent
{
    public required Guid ClientEventId { get; init; }

    public required string MachineId { get; init; }

    public required string UserSid { get; init; }

    public required BrowserType Browser { get; init; }

    public required string RawUrl { get; init; }

    public string? NormalizedUrl { get; init; }

    public string? Domain { get; init; }

    public required UrlSchemeCategory Category { get; init; }

    public required DateTimeOffset OccurredAtUtc { get; init; }

    string ISyncableEvent.Channel => "browser-navigation";

    SyncPriority ISyncableEvent.Priority => SyncPriority.Batched;
}
