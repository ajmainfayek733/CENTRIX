using System.IO;
using Agent.Core.Identity;
using Agent.Core.Policy;
using Agent.Core.Security;
using Agent.Core.Time;
using Agent.Native;
using Agent.Native.Sessions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Collectors.Screenshot;

public sealed class ScreenshotCollectorService(
    IScreenCapturer screenCapturer,
    IVirtualScreenBoundsProvider virtualScreenBoundsProvider,
    IDesktopSessionDetector desktopSessionDetector,
    ISessionEventSource sessionEvents,
    IPowerEventSource powerEvents,
    ICurrentUserProvider currentUserProvider,
    IDeviceContextProvider deviceContext,
    IScreenshotEncryptor encryptor,
    IScreenshotRepository repository,
    IPolicyProvider policyProvider,
    ISystemClock clock,
    ILogger<ScreenshotCollectorService> logger,
    string storageDirectory) : IHostedService, IDisposable
{
    private Timer? _timer;
    private volatile bool _isLocked;
    private volatile bool _isSleeping;
    private volatile bool _isOffline = true;
    private readonly string _userSid = currentUserProvider.GetCurrentUserSid();

    public Task StartAsync(CancellationToken cancellationToken)
    {
        sessionEvents.SessionChanged += OnSessionChanged;
        powerEvents.PowerChanged += OnPowerChanged;
        Directory.CreateDirectory(storageDirectory);
        RescheduleTimer();
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        sessionEvents.SessionChanged -= OnSessionChanged;
        powerEvents.PowerChanged -= OnPowerChanged;
        _timer?.Dispose();
        return Task.CompletedTask;
    }

    public void Dispose() => _timer?.Dispose();

    private void RescheduleTimer()
    {
        var interval = policyProvider.Current.Screenshot.CaptureInterval;
        _timer?.Dispose();
        _timer = new Timer(_ => _ = CaptureAsync(), null, interval, interval);
    }

    private void OnSessionChanged(object? sender, SessionChangeNotification notification)
    {
        switch (notification.Reason)
        {
            case SessionChangeReasonKind.SessionLock:
                _isLocked = true;
                break;
            case SessionChangeReasonKind.SessionUnlock:
                _isLocked = false;
                break;
            case SessionChangeReasonKind.SessionLogon:
                _isOffline = false;
                break;
            case SessionChangeReasonKind.SessionLogoff:
                _isOffline = true;
                break;
        }
    }

    private void OnPowerChanged(object? sender, PowerChangeNotification notification)
    {
        switch (notification.Kind)
        {
            case PowerChangeKind.Suspend:
                _isSleeping = true;
                break;
            case PowerChangeKind.ResumeAutomatic:
            case PowerChangeKind.ResumeSuspend:
            case PowerChangeKind.ResumeCritical:
                _isSleeping = false;
                break;
        }
    }

    private async Task CaptureAsync()
    {
        var policy = policyProvider.Current.Screenshot;
        var canCapture = ScreenshotCaptureGate.ShouldCapture(
            policy.Enabled,
            _isLocked,
            _isSleeping,
            _isOffline,
            desktopSessionDetector.IsInteractiveDesktopAvailable());

        if (!canCapture)
        {
            return;
        }

        try
        {
            var bounds = virtualScreenBoundsProvider.GetBounds();
            var captured = screenCapturer.Capture(bounds, policy.JpegQuality);
            if (captured is null)
            {
                logger.LogWarning("Screenshot capture failed (driver reset, GDI exhaustion, or similar transient issue).");
                return;
            }

            var clientEventId = Guid.NewGuid();
            var encrypted = encryptor.Encrypt(captured.JpegBytes);
            var filePath = Path.Combine(storageDirectory, $"{clientEventId}.enc");
            await File.WriteAllBytesAsync(filePath, encrypted, CancellationToken.None).ConfigureAwait(false);

            var record = new ScreenshotRecord
            {
                ClientEventId = clientEventId,
                MachineId = deviceContext.Current.MachineId,
                UserSid = _userSid,
                CapturedAtUtc = clock.UtcNow,
                Width = captured.Width,
                Height = captured.Height,
                MonitorCount = bounds.MonitorCount,
                LocalEncryptedFilePath = filePath,
                EncodedSizeBytes = captured.JpegBytes.LongLength
            };

            await repository.SaveAsync(record, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to capture or persist screenshot.");
        }
    }
}
