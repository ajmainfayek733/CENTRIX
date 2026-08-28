namespace Agent.Native.Input;

public sealed record IdleStateChangeNotification(bool IsIdle, DateTimeOffset OccurredAtUtc);

public interface IIdleStateSource
{
    event EventHandler<IdleStateChangeNotification>? IdleStateChanged;
}
