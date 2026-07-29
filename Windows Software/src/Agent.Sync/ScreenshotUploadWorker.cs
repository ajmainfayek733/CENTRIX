using Agent.Collectors.Screenshot;
using Agent.Core.Consent;
using Agent.Core.Policy;
using Agent.Core.Security;
using Agent.Core.Sync;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Sync;

/// <summary>
/// Screenshots don't flow through the generic outbox — the payload is a large binary blob
/// uploaded via IBackendClient's dedicated multipart-style path, decrypted locally first since
/// TLS (not double encryption) covers transit. Uploads are held back until <see cref="ConsentGate"/>
/// reports the device's monitoring notice has been acknowledged (see ConsentGateHostedService).
/// </summary>
public sealed class ScreenshotUploadWorker(
    IScreenshotRepository repository,
    IScreenshotEncryptor encryptor,
    IBackendClient backendClient,
    IPolicyProvider policyProvider,
    ConsentGate consentGate,
    ILogger<ScreenshotUploadWorker> logger) : IHostedService, IDisposable
{
    private Timer? _timer;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        var interval = policyProvider.Current.Sync.BatchInterval;
        _timer = new Timer(_ => _ = UploadPendingAsync(), null, interval, interval);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _timer?.Dispose();
        return Task.CompletedTask;
    }

    public void Dispose() => _timer?.Dispose();

    private async Task UploadPendingAsync()
    {
        if (!consentGate.IsAcknowledged)
        {
            return;
        }

        try
        {
            var pending = await repository.GetPendingUploadsAsync(policyProvider.Current.Sync.MaxBatchSize, CancellationToken.None).ConfigureAwait(false);

            foreach (var screenshot in pending)
            {
                await UploadOneAsync(screenshot).ConfigureAwait(false);
            }

            await repository.PurgeExpiredUnuploadedAsync(
                TimeSpan.FromDays(policyProvider.Current.Retention.UndeliveredRetentionDays),
                CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Screenshot upload cycle failed unexpectedly.");
        }
    }

    private async Task UploadOneAsync(ScreenshotRecord screenshot)
    {
        var tempPath = Path.Combine(Path.GetTempPath(), $"{screenshot.ClientEventId}.jpg");

        try
        {
            var encryptedBytes = await File.ReadAllBytesAsync(screenshot.LocalEncryptedFilePath, CancellationToken.None).ConfigureAwait(false);
            var plaintext = encryptor.Decrypt(encryptedBytes);
            await File.WriteAllBytesAsync(tempPath, plaintext, CancellationToken.None).ConfigureAwait(false);

            var request = new ScreenshotUploadRequest(screenshot.ClientEventId, screenshot.MachineId, screenshot.CapturedAtUtc, tempPath, "image/jpeg");
            var result = await backendClient.UploadScreenshotAsync(request, CancellationToken.None).ConfigureAwait(false);

            if (result.Success)
            {
                await repository.MarkUploadedAsync(screenshot.ClientEventId, CancellationToken.None).ConfigureAwait(false);
            }
            else
            {
                logger.LogWarning("Screenshot upload failed for {ClientEventId}: {Error}", screenshot.ClientEventId, result.Error);
            }
        }
        finally
        {
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }
        }
    }
}
