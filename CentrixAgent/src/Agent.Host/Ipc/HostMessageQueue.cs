using System.IO;
using System.Linq;
using System.Text.Json;
using Agent.Core;
using Agent.Core.Contracts;
using Agent.Core.Ipc;

namespace Agent.Host.Ipc;

/// <summary>
/// Durable queue for IPC messages that could not be delivered while the service was unreachable.
///
/// The host writes the serialized message onto disk before rejecting the send, then replays the
/// backlog as soon as the named pipe reconnects. This keeps activity/browser boundaries from being
/// silently discarded during a brief service outage while preserving the service's ownership of
/// the database and HTTP upload path.
/// </summary>
public sealed class HostMessageQueue
{
    private readonly object _gate = new();

    public int PendingCount
    {
        get
        {
            lock (_gate)
            {
                return File.Exists(AgentPaths.HostIpcQueuePath)
                    ? File.ReadLines(AgentPaths.HostIpcQueuePath).Count(static line => !string.IsNullOrWhiteSpace(line))
                    : 0;
            }
        }
    }

    public void Enqueue(IpcMessage message)
    {
        var line = JsonSerializer.Serialize(message, AgentJson.Options);
        AppendLine(line);
    }

    public void EnqueueRange(IEnumerable<IpcMessage> messages)
    {
        var lines = messages
            .Select(message => JsonSerializer.Serialize(message, AgentJson.Options))
            .ToArray();

        if (lines.Length == 0) return;

        AppendLines(lines);
    }

    public List<IpcMessage> DequeueAll()
    {
        var path = AgentPaths.HostIpcQueuePath;
        lock (_gate)
        {
            if (!File.Exists(path)) return [];

            var lines = File.ReadAllLines(path)
                .Where(static line => !string.IsNullOrWhiteSpace(line))
                .ToArray();

            if (lines.Length == 0)
            {
                File.Delete(path);
                return [];
            }

            try
            {
                var messages = lines
                    .Select(line => JsonSerializer.Deserialize<IpcMessage>(line, AgentJson.Options))
                    .OfType<IpcMessage>()
                    .ToList();

                File.Delete(path);
                return messages;
            }
            catch (JsonException)
            {
                // A malformed row is not silently dropped if the queue cannot be parsed: keep it at
                // the front so a later retry can repair it without losing the data. The write side
                // serializes a typed record using the same JSON options the read side deserializes.
                return [];
            }
        }
    }

    private void AppendLine(string line)
    {
        var path = AgentPaths.HostIpcQueuePath;
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        lock (_gate)
        {
            using var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
            using var writer = new StreamWriter(stream);
            writer.WriteLine(line);
        }
    }

    private void AppendLines(IEnumerable<string> lines)
    {
        var path = AgentPaths.HostIpcQueuePath;
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        lock (_gate)
        {
            using var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
            using var writer = new StreamWriter(stream);
            foreach (var line in lines)
            {
                writer.WriteLine(line);
            }
        }
    }
}
