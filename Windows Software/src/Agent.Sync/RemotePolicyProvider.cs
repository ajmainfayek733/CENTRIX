using System.Text.Json;
using Agent.Core.Policy;
using Agent.Core.Sync;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Sync;

/// <summary>
/// Polls the backend for policy updates and caches the last-known-good document locally so the
/// agent keeps running correctly offline. Starts from the cached file (or
/// <see cref="PolicyDocument.Default"/> on first run) rather than blocking startup on a network
/// call - "Admin can turn off any feature" doesn't require the network to be up first.
/// </summary>
public sealed class RemotePolicyProvider : IPolicyProvider, IHostedService, IDisposable
{
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(2);

    private readonly IBackendClient _backendClient;
    private readonly string _cacheFilePath;
    private readonly ILogger<RemotePolicyProvider> _logger;
    private Timer? _timer;
    private PolicyDocument _current;

    public RemotePolicyProvider(IBackendClient backendClient, string cacheFilePath, ILogger<RemotePolicyProvider> logger)
    {
        _backendClient = backendClient;
        _cacheFilePath = cacheFilePath;
        _logger = logger;
        _current = LoadCachedOrDefault(cacheFilePath, logger);
    }

    public PolicyDocument Current => _current;

    public event EventHandler<PolicyDocument>? PolicyChanged;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _timer = new Timer(_ => _ = RefreshAsync(), null, TimeSpan.Zero, RefreshInterval);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _timer?.Dispose();
        return Task.CompletedTask;
    }

    public void Dispose() => _timer?.Dispose();

    private async Task RefreshAsync()
    {
        try
        {
            var latest = await _backendClient.GetPolicyAsync(CancellationToken.None).ConfigureAwait(false);
            if (latest.Version == _current.Version)
            {
                return;
            }

            _current = latest;
            SaveCache(latest);
            PolicyChanged?.Invoke(this, latest);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to refresh policy from backend; continuing with cached/default policy.");
        }
    }

    private static PolicyDocument LoadCachedOrDefault(string path, ILogger logger)
    {
        try
        {
            if (File.Exists(path))
            {
                var cached = JsonSerializer.Deserialize<PolicyDocument>(File.ReadAllText(path));
                if (cached is not null)
                {
                    return cached;
                }
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            logger.LogWarning(ex, "Failed to load cached policy; falling back to defaults.");
        }

        return PolicyDocument.Default;
    }

    private void SaveCache(PolicyDocument policy)
    {
        try
        {
            var directory = Path.GetDirectoryName(_cacheFilePath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            File.WriteAllText(_cacheFilePath, JsonSerializer.Serialize(policy));
        }
        catch (IOException ex)
        {
            _logger.LogWarning(ex, "Failed to persist policy cache.");
        }
    }
}
