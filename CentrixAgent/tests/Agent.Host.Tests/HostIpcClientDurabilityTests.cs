using Agent.Core.Contracts;
using Agent.Core.Ipc;
using Agent.Host.Ipc;
using Microsoft.Extensions.Logging.Abstractions;

namespace Agent.Host.Tests;

public sealed class HostIpcClientDurabilityTests
{
    [Fact]
    public async Task SendAsync_Persists_WhenPipeIsDisconnected()
    {
        var client = new HostIpcClient(new NullLogger<HostIpcClient>());
        var eventId = Guid.NewGuid();
        var message = new SubmitActivitySessionMessage
        {
            Event = new ActivitySessionEvent
            {
                ClientEventId = eventId,
                ActivitySessionId = Guid.NewGuid(),
                SessionId = Guid.NewGuid(),
                AppName = "Edge",
                ProcessName = "msedge",
                ExecutablePath = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
                Type = ActivityType.Application,
                WindowTitle = "Example",
                StartTime = DateTimeOffset.UtcNow.AddMinutes(-5),
                EndTime = DateTimeOffset.UtcNow,
                DurationSeconds = 300,
                Reason = ActivityEndReason.AppSwitch,
                ProductivityTag = ProductivityTag.Neutral
            }
        };

        var persisted = await client.TryPersistAsync(message, CancellationToken.None);

        Assert.True(persisted);
        Assert.True(client.PendingMessageCount > 0);
    }
}
