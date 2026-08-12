using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using Agent.Core.Contracts;

namespace Agent.Core.Ipc;

/// <summary>
/// Length-prefixed framing over a pipe stream.
///
/// Byte mode with an explicit 4-byte big-endian length rather than PipeTransmissionMode.Message:
/// message mode silently truncates anything larger than the read buffer, and a policy document
/// with a long category list can exceed a small buffer. An explicit length makes an oversized
/// frame a hard error instead of a corrupted one.
/// </summary>
public static class IpcChannel
{
    /// <summary>
    /// Ceiling on a single frame. Screenshots travel as file paths, not bytes, so nothing
    /// legitimate approaches this - it exists to bound a malformed or hostile length prefix.
    /// </summary>
    private const int MaxFrameBytes = 4 * 1024 * 1024;

    public static async Task WriteMessageAsync(Stream stream, IpcMessage message, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(message, typeof(IpcMessage), AgentJson.Options);
        var payload = Encoding.UTF8.GetBytes(json);

        if (payload.Length > MaxFrameBytes)
        {
            throw new InvalidOperationException(
                $"IPC frame of {payload.Length} bytes exceeds the {MaxFrameBytes}-byte limit");
        }

        var header = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(header, payload.Length);

        await stream.WriteAsync(header, ct).ConfigureAwait(false);
        await stream.WriteAsync(payload, ct).ConfigureAwait(false);
        await stream.FlushAsync(ct).ConfigureAwait(false);
    }

    /// <summary>Reads one frame, or returns null when the peer closed the pipe cleanly.</summary>
    public static async Task<IpcMessage?> ReadMessageAsync(Stream stream, CancellationToken ct = default)
    {
        var header = new byte[4];
        if (!await ReadExactlyAsync(stream, header, ct).ConfigureAwait(false)) return null;

        var length = BinaryPrimitives.ReadInt32BigEndian(header);
        if (length <= 0 || length > MaxFrameBytes)
        {
            throw new InvalidDataException($"IPC frame length {length} is out of range");
        }

        var payload = new byte[length];
        if (!await ReadExactlyAsync(stream, payload, ct).ConfigureAwait(false))
        {
            throw new EndOfStreamException("IPC peer disconnected mid-frame");
        }

        var json = Encoding.UTF8.GetString(payload);
        return JsonSerializer.Deserialize<IpcMessage>(json, AgentJson.Options);
    }

    private static async Task<bool> ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken ct)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(offset), ct).ConfigureAwait(false);
            if (read == 0) return false;
            offset += read;
        }
        return true;
    }
}
