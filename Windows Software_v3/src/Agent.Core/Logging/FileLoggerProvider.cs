using System.Collections.Concurrent;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

namespace Agent.Core.Logging;

/// <summary>
/// Settings for <see cref="FileLoggerProvider"/>.
///
/// Every field has a working default except the prefix, which must differ per writing process:
/// the service and each per-session host append to their own file, so two processes never share
/// a handle and interleave half-written lines.
/// </summary>
public sealed record FileLogOptions
{
    /// <summary>
    /// Leading component of the file name, e.g. <c>service</c> or <c>host-s2</c>. Also the glob
    /// used when pruning, so a process only ever deletes its own history.
    /// </summary>
    public required string FileNamePrefix { get; init; }

    public string Directory { get; init; } = AgentPaths.LogDirectory;

    /// <summary>
    /// Floor applied before the message is even formatted. Standard `Logging:LogLevel` filters
    /// still apply on top of this — this is the cheap first gate, not the only one.
    /// </summary>
    public LogLevel MinimumLevel { get; init; } = LogLevel.Information;

    /// <summary>Rolls to <c>{prefix}-{date}.1.log</c>, <c>.2.log</c>, … past this size.</summary>
    public long MaxFileBytes { get; init; } = 8L * 1024 * 1024;

    /// <summary>
    /// Best-effort age cutoff, applied whenever a file is opened. The host runs as a standard
    /// user and may not be permitted to delete, so <see cref="Agent.Core"/> consumers running as
    /// SYSTEM should not rely on this alone.
    /// </summary>
    public int RetainedFileDays { get; init; } = 14;
}

/// <summary>
/// Appends formatted log lines to a dated file, rolling by day and by size.
///
/// Deliberately hand-rolled rather than pulling in a logging framework: the agent publishes
/// self-contained to 30 workstations and this is the only sink it needs beyond the Event Log.
///
/// The one hard rule is that logging must never take the agent down — a full disk, a revoked
/// ACL or a file deleted underneath us all end in a dropped line and a retry on the next write,
/// never an exception escaping to the caller.
/// </summary>
internal sealed class FileLogWriter(FileLogOptions options) : IDisposable
{
    private readonly FileLogOptions _options = options;
    private readonly object _gate = new();

    private StreamWriter? _writer;
    private DateOnly _openedOn;
    private long _writtenBytes;
    private int _rollIndex;
    private bool _disposed;

    public void Write(string line)
    {
        lock (_gate)
        {
            if (_disposed) return;

            try
            {
                // Local date, not UTC: an administrator reading these correlates them with the
                // workstation's own clock and with the Event Log, which is also local.
                var today = DateOnly.FromDateTime(DateTime.Now);

                if (_writer is null || today != _openedOn)
                {
                    Open(today, startNewDay: true);
                }
                else if (_writtenBytes >= _options.MaxFileBytes)
                {
                    Open(today, startNewDay: false);
                }

                _writer!.WriteLine(line);
                _writtenBytes += line.Length + Environment.NewLine.Length;
            }
            catch (Exception)
            {
                // Drop the handle so the next line re-opens rather than failing forever against
                // a stream that is already broken.
                CloseWriter();
            }
        }
    }

    private void Open(DateOnly day, bool startNewDay)
    {
        CloseWriter();

        if (startNewDay)
        {
            _openedOn = day;
            _rollIndex = 0;
        }
        else
        {
            _rollIndex++;
        }

        System.IO.Directory.CreateDirectory(_options.Directory);

        // A restart mid-day re-opens the file it was already using, so skip forward past any
        // roll segment that is already at the cap instead of appending past it.
        string path;
        while (true)
        {
            path = Path.Combine(_options.Directory, FileNameFor(day, _rollIndex));
            var existing = new FileInfo(path);
            if (existing.Exists && existing.Length >= _options.MaxFileBytes)
            {
                _rollIndex++;
                continue;
            }
            break;
        }

        // FileShare.ReadWrite so an administrator can tail the file, and so a second process
        // that somehow shares the prefix degrades to interleaved lines rather than a hard failure.
        var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);

        // AutoFlush because the interesting lines are the ones written just before a crash.
        // Agent log volume is a few lines a minute, so the syscall cost is irrelevant.
        _writer = new StreamWriter(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
        {
            AutoFlush = true
        };
        _writtenBytes = stream.Length;
        _openedOn = day;

        Prune();
    }

    private string FileNameFor(DateOnly day, int index) => index == 0
        ? $"{_options.FileNamePrefix}-{day:yyyyMMdd}.log"
        : $"{_options.FileNamePrefix}-{day:yyyyMMdd}.{index}.log";

    /// <summary>Best-effort age sweep. Anything that throws here is not worth failing a log write over.</summary>
    private void Prune()
    {
        if (_options.RetainedFileDays <= 0) return;

        try
        {
            var cutoff = DateTime.Now.AddDays(-_options.RetainedFileDays);

            foreach (var file in System.IO.Directory.EnumerateFiles(_options.Directory, $"{_options.FileNamePrefix}-*.log"))
            {
                try
                {
                    if (File.GetLastWriteTime(file) < cutoff) File.Delete(file);
                }
                catch (Exception)
                {
                    // Locked by a reader, or the caller lacks delete rights. The SYSTEM-side
                    // sweep in RetentionWorker is the backstop.
                }
            }
        }
        catch (Exception)
        {
            // Directory vanished or is unreadable; the next open recreates it.
        }
    }

    private void CloseWriter()
    {
        try
        {
            _writer?.Dispose();
        }
        catch (Exception)
        {
            // Flushing a stream on a full disk throws. Nothing useful to do about it here.
        }

        _writer = null;
        _writtenBytes = 0;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            CloseWriter();
        }
    }
}

/// <summary>
/// One <see cref="ILogger"/> per category, all sharing the provider's single file handle.
/// </summary>
internal sealed class FileLogger(
    string category,
    FileLogOptions options,
    FileLogWriter writer,
    Func<IExternalScopeProvider?> scopeProvider) : ILogger
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull =>
        scopeProvider()?.Push(state);

    public bool IsEnabled(LogLevel logLevel) =>
        logLevel != LogLevel.None && logLevel >= options.MinimumLevel;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (!IsEnabled(logLevel)) return;

        var message = formatter(state, exception);
        if (message.Length == 0 && exception is null) return;

        var line = new StringBuilder(256)
            .Append(DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss.fff zzz"))
            .Append(" [")
            .Append(Abbreviate(logLevel))
            .Append("] ")
            .Append(category);

        if (eventId.Id != 0) line.Append('(').Append(eventId.Id).Append(')');

        // Scopes carry the correlation that makes a sync failure traceable back to a channel.
        scopeProvider()?.ForEachScope(static (scope, sb) => sb.Append(" => ").Append(scope), line);

        line.Append(": ").Append(message);

        if (exception is not null) line.Append(Environment.NewLine).Append(exception);

        writer.Write(line.ToString());
    }

    /// <summary>Fixed-width levels so the file stays column-aligned and greppable.</summary>
    private static string Abbreviate(LogLevel level) => level switch
    {
        LogLevel.Trace => "TRC",
        LogLevel.Debug => "DBG",
        LogLevel.Information => "INF",
        LogLevel.Warning => "WRN",
        LogLevel.Error => "ERR",
        LogLevel.Critical => "CRT",
        _ => "???"
    };
}

/// <summary>
/// Rolling-file logging provider for both agent processes.
///
/// <see cref="AgentPaths.EnsureCreated"/> makes the directory at startup, but this provider does
/// not depend on that having run — the directory is created on first write, which is what lets
/// it be registered before configuration has even been read.
/// </summary>
[ProviderAlias("File")]
public sealed class FileLoggerProvider : ILoggerProvider, ISupportExternalScope
{
    private readonly FileLogOptions _options;
    private readonly FileLogWriter _writer;
    private readonly ConcurrentDictionary<string, FileLogger> _loggers = new(StringComparer.Ordinal);
    private IExternalScopeProvider? _scopes;

    public FileLoggerProvider(FileLogOptions options)
    {
        _options = options;
        _writer = new FileLogWriter(options);
    }

    public ILogger CreateLogger(string categoryName) =>
        _loggers.GetOrAdd(categoryName, name => new FileLogger(name, _options, _writer, () => _scopes));

    public void SetScopeProvider(IExternalScopeProvider scopeProvider) => _scopes = scopeProvider;

    public void Dispose()
    {
        _loggers.Clear();
        _writer.Dispose();
    }
}

public static class FileLoggerBuilderExtensions
{
    /// <summary>
    /// Adds the rolling-file sink under <see cref="AgentPaths.LogDirectory"/>.
    ///
    /// Both agent processes call this. Without it the log directory is created at startup and
    /// then stays empty, which is exactly as useless as it sounds when diagnosing a workstation
    /// you cannot attach a debugger to.
    /// </summary>
    public static ILoggingBuilder AddAgentFileLog(this ILoggingBuilder builder, FileLogOptions options)
    {
        builder.Services.TryAddEnumerable(
            ServiceDescriptor.Singleton<ILoggerProvider, FileLoggerProvider>(_ => new FileLoggerProvider(options)));
        return builder;
    }

    /// <summary>
    /// Standalone factory for code that runs before (or instead of) a host — the service's
    /// configuration-load failure path, where the whole point is to leave a record on disk of why
    /// the service refused to start.
    /// </summary>
    public static FileLoggerProvider CreateStandalone(FileLogOptions options) => new(options);
}
