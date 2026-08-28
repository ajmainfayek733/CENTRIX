namespace Agent.Collectors.AppSession;

public sealed record AppSessionTransition(AppSessionState ClosedState, DateTimeOffset StartUtc, DateTimeOffset EndUtc);

/// <summary>
/// The exact state machine the spec describes: exactly one open session at a time; an unchanged
/// state (including window title) is a no-op; any change closes the previous session and opens
/// the new one. Pure and stateful-but-in-memory-only, so it's fully unit-testable without any
/// Windows dependency.
/// </summary>
public sealed class AppSessionTracker
{
    private (AppSessionState State, DateTimeOffset StartUtc)? _current;

    public (AppSessionState State, DateTimeOffset StartUtc)? Current => _current;

    /// <returns>The just-closed transition, or null if the state is unchanged or this is the first observation.</returns>
    public AppSessionTransition? Observe(AppSessionState newState, DateTimeOffset atUtc)
    {
        if (_current is not { } current)
        {
            _current = (newState, atUtc);
            return null;
        }

        if (current.State == newState)
        {
            return null;
        }

        var transition = new AppSessionTransition(current.State, current.StartUtc, atUtc);
        _current = (newState, atUtc);
        return transition;
    }

    /// <summary>Force-closes the open session without opening a new one (e.g. service shutdown).</summary>
    public AppSessionTransition? Close(DateTimeOffset atUtc)
    {
        if (_current is not { } current)
        {
            return null;
        }

        _current = null;
        return new AppSessionTransition(current.State, current.StartUtc, atUtc);
    }
}
