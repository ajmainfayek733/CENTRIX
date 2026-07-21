using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Polly;
using Polly.CircuitBreaker;
using Agent.Core;

namespace Agent.Sync
{
    public class HttpSyncClient : ISyncClient
    {
        private readonly HttpClient _httpClient;
        private readonly IAgentConfigProvider _configProvider;
        private readonly ResiliencePipeline<HttpResponseMessage> _resiliencePipeline;

        public HttpSyncClient(HttpClient httpClient, IAgentConfigProvider configProvider)
        {
            _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
            _configProvider = configProvider ?? throw new ArgumentNullException(nameof(configProvider));

            // Set up Polly v8 resilience pipeline with Retry and Circuit Breaker
            _resiliencePipeline = new ResiliencePipelineBuilder<HttpResponseMessage>()
                .AddRetry(new Polly.Retry.RetryStrategyOptions<HttpResponseMessage>
                {
                    ShouldHandle = new PredicateBuilder<HttpResponseMessage>()
                        .Handle<HttpRequestException>()
                        .HandleResult(r => (int)r.StatusCode >= 500),
                    MaxRetryAttempts = 3,
                    Delay = TimeSpan.FromSeconds(2),
                    BackoffType = DelayBackoffType.Exponential,
                    UseJitter = true
                })
                .AddCircuitBreaker(new CircuitBreakerStrategyOptions<HttpResponseMessage>
                {
                    ShouldHandle = new PredicateBuilder<HttpResponseMessage>()
                        .Handle<HttpRequestException>()
                        .HandleResult(r => (int)r.StatusCode >= 500),
                    FailureRatio = 0.5, // Break if 50% of requests fail in a sampling window
                    SamplingDuration = TimeSpan.FromSeconds(30),
                    MinimumThroughput = 5,
                    BreakDuration = TimeSpan.FromSeconds(15)
                })
                .Build();
        }

        public async Task<bool> SyncBatchAsync(IngestBatch batch, CancellationToken ct)
        {
            if (batch.ActivityLogs.Length == 0 && 
                batch.Screenshots.Length == 0 && 
                batch.UsbLogs.Length == 0 && 
                batch.AttendanceRecords.Length == 0)
            {
                return true; // Nothing to sync
            }

            string serverUrl = _configProvider.GetServerUrl();
            string url = $"{serverUrl.TrimEnd('/')}/api/v1/ingest";

            string deviceId = _configProvider.GetDeviceId();
            string token = _configProvider.GetDeviceToken();

            // Generate Idempotency Key based on batch contents to prevent duplicate insertion
            string idempotencyKey = GenerateIdempotencyKey(batch);

            try
            {
                // Execute request inside Polly resilience pipeline
                var response = await _resiliencePipeline.ExecuteAsync(async context =>
                {
                    using var request = new HttpRequestMessage(HttpMethod.Post, url);
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                    request.Headers.Add("X-Device-ID", deviceId);
                    request.Headers.Add("X-Idempotency-Key", idempotencyKey);
                    
                    request.Content = JsonContent.Create(batch);

                    return await _httpClient.SendAsync(request, context);
                }, ct);

                if (response.IsSuccessStatusCode)
                {
                    return true;
                }
                
                if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized || 
                    response.StatusCode == System.Net.HttpStatusCode.Forbidden)
                {
                    // If server explicitly rejects credentials, don't retry this batch indefinitely.
                    // Return false to let orchestrator handle authentication error.
                    return false;
                }

                return false;
            }
            catch (BrokenCircuitException)
            {
                // Circuit is open - fail fast without sending request
                return false;
            }
            catch
            {
                // Any other exception (like network timeouts that exhausted retries)
                return false;
            }
        }

        private static string GenerateIdempotencyKey(IngestBatch batch)
        {
            // Create a deterministic hash based on device ID and CapturedAt timestamps of records
            var sb = new StringBuilder();
            sb.Append(batch.DeviceId);
            
            foreach (var log in batch.ActivityLogs)
            {
                sb.Append(log.CapturedAt.Ticks);
            }
            foreach (var shot in batch.Screenshots)
            {
                sb.Append(shot.CapturedAt.Ticks);
            }
            foreach (var usb in batch.UsbLogs)
            {
                sb.Append(usb.CapturedAt.Ticks);
            }
            foreach (var att in batch.AttendanceRecords)
            {
                sb.Append(att.Date.DayNumber);
            }

            byte[] inputBytes = Encoding.UTF8.GetBytes(sb.ToString());
            byte[] hashBytes = SHA256.HashData(inputBytes);
            return Convert.ToHexString(hashBytes);
        }
    }
}
