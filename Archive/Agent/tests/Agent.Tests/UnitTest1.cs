using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Xunit;
using Agent.Collectors;
using Agent.Buffering;
using Agent.Sync;
using Agent.Config;
using Agent.Core;

namespace Agent.Tests
{
    public class AgentTests : IDisposable
    {
        private readonly string _testDbFile = "test_buffer.db";

        public void Dispose()
        {
            // Clean up test DB after each test
            string dbPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, _testDbFile);
            if (File.Exists(dbPath))
            {
                try
                {
                    File.Delete(dbPath);
                    // Also delete WAL files if any
                    File.Delete(dbPath + "-wal");
                    File.Delete(dbPath + "-shm");
                }
                catch { }
            }
        }

        [Fact]
        public async Task TestAppFocusCollector_WithSimulation_ReturnsMockData()
        {
            // Arrange
            var win32Service = new SimulationWin32Service();
            var collector = new AppFocusCollector(win32Service);

            // Act
            var (appName, windowTitle) = await collector.GetActiveWindowAsync(CancellationToken.None);

            // Assert
            Assert.NotNull(appName);
            Assert.NotNull(windowTitle);
            Assert.Contains(appName, new[] { "chrome", "code", "Teams", "explorer", "cmd" });
        }

        [Fact]
        public async Task TestIdleStateCollector_WithSimulation_MeasuresIdleTime()
        {
            // Arrange
            var win32Service = new SimulationWin32Service();
            var collector = new IdleStateCollector(win32Service);

            // Act
            uint idleMs = await collector.GetIdleDurationMsAsync(CancellationToken.None);

            // Assert
            // The simulation initializes ticks at 100,000, increments it by 15,000 during GetLastInputTime
            // check. If the user is active, lastInputTime = currentTick = 115,000.
            // If active, idle duration is 0. If idle, it is 15,000.
            Assert.True(idleMs == 0 || idleMs == 15000);
        }

        [Fact]
        public async Task TestSqliteLocalStore_DurableQueueOperations()
        {
            // Arrange
            var store = new SqliteLocalStore(_testDbFile);
            await store.InitializeAsync();

            string deviceId = "TestDevice123";
            var activityLog = new ActivityLog(
                DeviceId: deviceId,
                AppName: "chrome",
                WindowTitle: "Test Title",
                Domain: null,
                IsIdle: false,
                ActivityScore: 10,
                CapturedAt: DateTimeOffset.UtcNow
            );

            // Act - Enqueue
            await store.EnqueueActivityAsync(activityLog);

            // Assert - Retrieve unsynced batch
            var batch = await store.GetUnsyncedBatchAsync(10);
            Assert.Equal(deviceId, batch.DeviceId);
            Assert.Single(batch.ActivityLogs);
            
            var retrievedLog = batch.ActivityLogs[0];
            Assert.Equal("chrome", retrievedLog.AppName);
            Assert.Equal("Test Title", retrievedLog.WindowTitle);
            Assert.Equal(10, retrievedLog.ActivityScore);
            Assert.False(retrievedLog.IsIdle);

            // Act - Mark Synced
            await store.MarkBatchSyncedAsync(batch);

            // Assert - Synced records should not be returned in next batch
            var emptyBatch = await store.GetUnsyncedBatchAsync(10);
            Assert.Empty(emptyBatch.ActivityLogs);

            // Act - Purge
            await store.PurgeSyncedRecordsAsync(0); // Purge everything synced older than 0 days
        }

        [Fact]
        public async Task TestHttpSyncClient_PollyRetryOnTransientError()
        {
            // Arrange
            int callCount = 0;
            var mockHandler = new MockHttpMessageHandler((request) =>
            {
                callCount++;
                if (callCount < 2)
                {
                    // First call: server error
                    return new HttpResponseMessage(HttpStatusCode.InternalServerError);
                }
                // Second call: success
                return new HttpResponseMessage(HttpStatusCode.OK);
            });

            var httpClient = new HttpClient(mockHandler);
            
            // Mock config provider
            var configMock = new MockConfigProvider("http://localhost", "device1", "token1");
            var syncClient = new HttpSyncClient(httpClient, configMock);

            var batch = new IngestBatch(
                DeviceId: "device1",
                ActivityLogs: new[] {
                    new ActivityLog("device1", "chrome", "title", null, false, 5, DateTimeOffset.UtcNow)
                },
                Screenshots: Array.Empty<ScreenshotRecord>(),
                UsbLogs: Array.Empty<UsbDeviceRecord>(),
                AttendanceRecords: Array.Empty<AttendanceRecord>()
            );

            // Act
            bool success = await syncClient.SyncBatchAsync(batch, CancellationToken.None);

            // Assert
            Assert.True(success);
            Assert.Equal(2, callCount); // Polly should have retried once after 500 error
        }
    }

    // Helper classes for testing
    public class MockHttpMessageHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _responseFunc;

        public MockHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> responseFunc)
        {
            _responseFunc = responseFunc;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            return Task.FromResult(_responseFunc(request));
        }
    }

    public class MockConfigProvider : IAgentConfigProvider
    {
        private readonly string _url;
        private readonly string _id;
        private readonly string _token;

        public MockConfigProvider(string url, string id, string token)
        {
            _url = url;
            _id = id;
            _token = token;
        }

        public Task<AgentSettings> GetSettingsAsync(CancellationToken ct)
        {
            return Task.FromResult(new AgentSettings());
        }

        public Task RefreshSettingsAsync(CancellationToken ct)
        {
            return Task.CompletedTask;
        }

        public string GetDeviceId() => _id;
        public string GetDeviceToken() => _token;
        public string GetServerUrl() => _url;
    }
}
