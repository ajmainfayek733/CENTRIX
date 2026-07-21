using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Agent.Core;

namespace Agent.Service
{
    public class MonitoringWindowsService : BackgroundService
    {
        private readonly ILogger<MonitoringWindowsService> _logger;
        private readonly IActivityCollector _activityCollector;
        private readonly IIdleDetector _idleDetector;
        private readonly IActivityLevelDetector _activityLevelDetector;
        private readonly IScreenshotCollector _screenshotCollector;
        private readonly IUsbDeviceCollector _usbCollector;
        private readonly ILocalStore _localStore;
        private readonly ISyncClient _syncClient;
        private readonly IAgentConfigProvider _configProvider;

        private DateTimeOffset _lastScreenshotTime = DateTimeOffset.MinValue;
        private DateTimeOffset _lastConfigRefreshTime = DateTimeOffset.MinValue;

        public MonitoringWindowsService(
            ILogger<MonitoringWindowsService> logger,
            IActivityCollector activityCollector,
            IIdleDetector idleDetector,
            IActivityLevelDetector activityLevelDetector,
            IScreenshotCollector screenshotCollector,
            IUsbDeviceCollector usbCollector,
            ILocalStore localStore,
            ISyncClient syncClient,
            IAgentConfigProvider configProvider)
        {
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
            _activityCollector = activityCollector ?? throw new ArgumentNullException(nameof(activityCollector));
            _idleDetector = idleDetector ?? throw new ArgumentNullException(nameof(idleDetector));
            _activityLevelDetector = activityLevelDetector ?? throw new ArgumentNullException(nameof(activityLevelDetector));
            _screenshotCollector = screenshotCollector ?? throw new ArgumentNullException(nameof(screenshotCollector));
            _usbCollector = usbCollector ?? throw new ArgumentNullException(nameof(usbCollector));
            _localStore = localStore ?? throw new ArgumentNullException(nameof(localStore));
            _syncClient = syncClient ?? throw new ArgumentNullException(nameof(syncClient));
            _configProvider = configProvider ?? throw new ArgumentNullException(nameof(configProvider));
        }

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            _logger.LogInformation("Agent Monitoring Service starting up...");

            try
            {
                // Initialize SQLite tables and journal WAL mode
                await _localStore.InitializeAsync();
                _logger.LogInformation("Local storage initialized successfully.");

                // Start inputs polling loop for activity level tracking
                _activityLevelDetector.StartListening();
                _logger.LogInformation("Activity level input listener started.");

                // Register USB listener
                string deviceId = _configProvider.GetDeviceId();
                _usbCollector.StartListening(async usbRecord =>
                {
                    try
                    {
                        var settings = await _configProvider.GetSettingsAsync(stoppingToken);
                        if (settings.UsbLoggingEnabled)
                        {
                            await _localStore.EnqueueUsbLogAsync(usbRecord);
                            _logger.LogDebug("Enqueued USB event: {Action} - {Device}", usbRecord.Action, usbRecord.DeviceName);
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Failed to capture and enqueue USB event.");
                    }
                });

                // Start the separate execution loops
                var samplingTask = StartSamplingLoopAsync(stoppingToken);
                var syncTask = StartSyncLoopAsync(stoppingToken);
                var purgeTask = StartPurgeLoopAsync(stoppingToken);

                // Wait for cancellation
                await Task.WhenAll(samplingTask, syncTask, purgeTask);
            }
            catch (OperationCanceledException)
            {
                _logger.LogInformation("Agent Monitoring Service execution was cancelled.");
            }
            catch (Exception ex)
            {
                _logger.LogCritical(ex, "Critical failure in Agent Monitoring Service execution.");
            }
            finally
            {
                _activityLevelDetector.StopListening();
                _usbCollector.StopListening();
                _logger.LogInformation("Agent Monitoring Service shutdown complete.");
            }
        }

        private async Task StartSamplingLoopAsync(CancellationToken ct)
        {
            _logger.LogInformation("Sampling loop started.");

            while (!ct.IsCancellationRequested)
            {
                var settings = await _configProvider.GetSettingsAsync(ct);
                int intervalSeconds = settings.SampleIntervalSeconds > 0 ? settings.SampleIntervalSeconds : 15;

                try
                {
                    await PerformSampleAsync(settings, ct);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error occurred during monitoring sample collection.");
                }

                await Task.Delay(TimeSpan.FromSeconds(intervalSeconds), ct);
            }
        }

        private async Task PerformSampleAsync(AgentSettings settings, CancellationToken ct)
        {
            DateTimeOffset now = DateTimeOffset.UtcNow;
            string deviceId = _configProvider.GetDeviceId();

            // 1. Refresh configurations dynamically every 5 minutes
            if (now - _lastConfigRefreshTime >= TimeSpan.FromMinutes(5))
            {
                _logger.LogInformation("Refreshing remote settings configurations...");
                await _configProvider.RefreshSettingsAsync(ct);
                _lastConfigRefreshTime = now;
                
                // Get updated settings
                settings = await _configProvider.GetSettingsAsync(ct);
            }

            // 2. Measure Idle duration
            bool isIdle = false;
            if (settings.IdleDetectionEnabled)
            {
                uint idleMs = await _idleDetector.GetIdleDurationMsAsync(ct);
                isIdle = idleMs >= (uint)(settings.IdleThresholdSeconds * 1000);
            }

            // 3. Get Active Window title and Process Name
            string? appName = null;
            string? windowTitle = null;
            if (settings.AppTrackingEnabled && !isIdle)
            {
                var (app, title) = await _activityCollector.GetActiveWindowAsync(ct);
                appName = app;
                windowTitle = title;
            }

            // 4. Get Activity Level Score
            int activityScore = 0;
            if (settings.ActivityLevelEnabled)
            {
                activityScore = _activityLevelDetector.GetAndResetActivityCount();
            }

            // 5. Construct and Enqueue Activity Log
            var log = new ActivityLog(
                DeviceId: deviceId,
                AppName: appName,
                WindowTitle: windowTitle,
                Domain: null, // Phase 2
                IsIdle: isIdle,
                ActivityScore: activityScore,
                CapturedAt: now
            );

            await _localStore.EnqueueActivityAsync(log);

            // 6. Update Daily Attendance
            if (settings.AttendanceEnabled)
            {
                await UpdateDailyAttendanceAsync(deviceId, isIdle, settings.SampleIntervalSeconds);
            }

            // 7. Perform Screenshot captures if enabled
            if (settings.ScreenshotsEnabled)
            {
                int screenshotIntervalMinutes = settings.ScreenshotIntervalMinutes > 0 ? settings.ScreenshotIntervalMinutes : 10;
                if (now - _lastScreenshotTime >= TimeSpan.FromMinutes(screenshotIntervalMinutes))
                {
                    _logger.LogInformation("Capturing periodic screenshot...");
                    byte[] encryptedScreenshot = await _screenshotCollector.CaptureScreenAsync(ct);
                    var screenshotRecord = new ScreenshotRecord(
                        DeviceId: deviceId,
                        CapturedAt: now,
                        EncryptedImageData: encryptedScreenshot
                    );
                    await _localStore.EnqueueScreenshotAsync(screenshotRecord);
                    _lastScreenshotTime = now;
                }
            }
        }

        private async Task UpdateDailyAttendanceAsync(string deviceId, bool isIdle, int sampleIntervalSeconds)
        {
            try
            {
                DateTimeOffset now = DateTimeOffset.UtcNow;
                DateOnly today = DateOnly.FromDateTime(DateTime.Today);

                // Attendance computation:
                // We write/update a record for today.
                // If it is the first sample of the day, FirstLogin = current time, LastLogout = null, ActiveSeconds = 0.
                // If the user was active in this sample (isIdle = false), we add the sample interval to TotalActiveSeconds and set LastLogout = current time.
                var attendance = new AttendanceRecord(
                    DeviceId: deviceId,
                    Date: today,
                    FirstLogin: now,
                    LastLogout: isIdle ? null : now,
                    TotalActiveSeconds: isIdle ? 0 : sampleIntervalSeconds
                );

                await _localStore.EnqueueAttendanceAsync(attendance);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to update daily attendance.");
            }
        }

        private async Task StartSyncLoopAsync(CancellationToken ct)
        {
            _logger.LogInformation("Sync loop started.");

            while (!ct.IsCancellationRequested)
            {
                var settings = await _configProvider.GetSettingsAsync(ct);
                int intervalSeconds = settings.SyncIntervalSeconds > 0 ? settings.SyncIntervalSeconds : 60;

                try
                {
                    // Fetch unsynced records from queue
                    var batch = await _localStore.GetUnsyncedBatchAsync(200);
                    
                    if (batch.ActivityLogs.Length > 0 || 
                        batch.Screenshots.Length > 0 || 
                        batch.UsbLogs.Length > 0 || 
                        batch.AttendanceRecords.Length > 0)
                    {
                        _logger.LogInformation("Uploading unsynced batch ({Activities} activities, {Screenshots} screenshots)...", 
                            batch.ActivityLogs.Length, batch.Screenshots.Length);

                        bool success = await _syncClient.SyncBatchAsync(batch, ct);
                        if (success)
                        {
                            await _localStore.MarkBatchSyncedAsync(batch);
                            _logger.LogInformation("Batch synchronized successfully.");
                        }
                        else
                        {
                            _logger.LogWarning("Synchronization failed. Data remains queued locally.");
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error occurred during sync execution loop.");
                }

                await Task.Delay(TimeSpan.FromSeconds(intervalSeconds), ct);
            }
        }

        private async Task StartPurgeLoopAsync(CancellationToken ct)
        {
            _logger.LogInformation("Purge cleanup loop started.");

            // Run database cleanups every 12 hours
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    _logger.LogInformation("Running database purge for synced records older than 90 days...");
                    await _localStore.PurgeSyncedRecordsAsync(90);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error during database purge.");
                }

                await Task.Delay(TimeSpan.FromHours(12), ct);
            }
        }
    }
}
