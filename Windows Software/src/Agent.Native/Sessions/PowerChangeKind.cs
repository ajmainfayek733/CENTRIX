namespace Agent.Native.Sessions;

public enum PowerChangeKind
{
    Suspend,
    ResumeAutomatic,
    ResumeSuspend,
    ResumeCritical,
    BatteryLow,
    PowerStatusChange
}

public sealed record PowerChangeNotification(PowerChangeKind Kind, DateTimeOffset OccurredAtUtc);

public interface IPowerEventSource
{
    event EventHandler<PowerChangeNotification>? PowerChanged;
}

public sealed class PowerEventPublisher : IPowerEventSource
{
    public event EventHandler<PowerChangeNotification>? PowerChanged;

    public void Publish(PowerChangeNotification notification) =>
        PowerChanged?.Invoke(this, notification);
}
