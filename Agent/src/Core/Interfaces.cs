using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Agent.Core
{
    public interface IActivityCollector
    {
        Task<(string? AppName, string? WindowTitle)> GetActiveWindowAsync(CancellationToken ct);
    }

    public interface IIdleDetector
    {
        Task<uint> GetIdleDurationMsAsync(CancellationToken ct);
    }

    public interface IActivityLevelDetector
    {
        int GetAndResetActivityCount();
        void StartListening();
        void StopListening();
    }

    public interface IScreenshotCollector
    {
        Task<byte[]> CaptureScreenAsync(CancellationToken ct);
    }

    public interface IUsbDeviceCollector
    {
        Task<IEnumerable<UsbDeviceRecord>> GetRecentUsbChangesAsync(CancellationToken ct);
        void StartListening(Action<UsbDeviceRecord> onUsbChanged);
        void StopListening();
    }

    public interface ILocalStore
    {
        Task InitializeAsync();
        Task EnqueueActivityAsync(ActivityLog log);
        Task EnqueueScreenshotAsync(ScreenshotRecord screenshot);
        Task EnqueueUsbLogAsync(UsbDeviceRecord usbLog);
        Task EnqueueAttendanceAsync(AttendanceRecord attendance);
        
        Task<IngestBatch> GetUnsyncedBatchAsync(int maxItems);
        Task MarkBatchSyncedAsync(IngestBatch batch);
        Task PurgeSyncedRecordsAsync(int olderThanDays);
    }

    public interface ISyncClient
    {
        Task<bool> SyncBatchAsync(IngestBatch batch, CancellationToken ct);
    }

    public interface IAgentConfigProvider
    {
        Task<AgentSettings> GetSettingsAsync(CancellationToken ct);
        Task RefreshSettingsAsync(CancellationToken ct);
        string GetDeviceId();
        string GetDeviceToken();
        string GetServerUrl();
    }
}
