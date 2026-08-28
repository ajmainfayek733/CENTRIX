using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Agent.Core;

namespace Agent.Config
{
    public class RemoteConfigProvider : IAgentConfigProvider
    {
        private readonly HttpClient _httpClient;
        private readonly string _secretsPath;
        private readonly string _settingsCachePath;
        
        private string _deviceId = string.Empty;
        private string _deviceToken = string.Empty;
        private string _serverUrl = "http://localhost:3000";
        private AgentSettings _currentSettings;

        private readonly object _lock = new();

        public RemoteConfigProvider(HttpClient httpClient)
        {
            _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
            _secretsPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent_secrets.json");
            _settingsCachePath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent_settings.json");
            _currentSettings = new AgentSettings();

            LoadSecretsAndInitialize();
        }

        private void LoadSecretsAndInitialize()
        {
            lock (_lock)
            {
                if (File.Exists(_secretsPath))
                {
                    try
                    {
                        string json = File.ReadAllText(_secretsPath);
                        using var doc = JsonDocument.Parse(json);
                        var root = doc.RootElement;

                        if (root.TryGetProperty("ServerUrl", out var urlProp))
                        {
                            _serverUrl = urlProp.GetString() ?? _serverUrl;
                        }

                        if (root.TryGetProperty("DeviceId", out var idProp))
                        {
                            _deviceId = idProp.GetString() ?? _deviceId;
                        }

                        if (root.TryGetProperty("EncryptedDeviceToken", out var tokenProp))
                        {
                            string encryptedBase64 = tokenProp.GetString() ?? string.Empty;
                            if (!string.IsNullOrEmpty(encryptedBase64))
                            {
                                byte[] cipher = Convert.FromBase64String(encryptedBase64);
                                byte[] rawToken = DecryptSecret(cipher);
                                _deviceToken = Encoding.UTF8.GetString(rawToken);
                            }
                        }
                    }
                    catch
                    {
                        // Fallback to auto-generation if parsing fails
                        GenerateDefaultSecrets();
                    }
                }
                else
                {
                    GenerateDefaultSecrets();
                }

                // Load cached settings if available
                if (File.Exists(_settingsCachePath))
                {
                    try
                    {
                        string json = File.ReadAllText(_settingsCachePath);
                        _currentSettings = JsonSerializer.Deserialize<AgentSettings>(json) ?? new AgentSettings();
                    }
                    catch
                    {
                        _currentSettings = new AgentSettings();
                    }
                }
            }
        }

        private void GenerateDefaultSecrets()
        {
            _deviceId = Environment.MachineName;
            _deviceToken = Guid.NewGuid().ToString("N"); // Temporary install token simulation
            _serverUrl = "http://localhost:3000";

            SaveSecrets();
        }

        private void SaveSecrets()
        {
            try
            {
                byte[] rawToken = Encoding.UTF8.GetBytes(_deviceToken);
                byte[] cipherToken = EncryptSecret(rawToken);
                string encryptedBase64 = Convert.ToBase64String(cipherToken);

                var secretsData = new
                {
                    ServerUrl = _serverUrl,
                    DeviceId = _deviceId,
                    EncryptedDeviceToken = encryptedBase64
                };

                string json = JsonSerializer.Serialize(secretsData, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(_secretsPath, json);
            }
            catch
            {
                // Suppress errors during installation environment startup
            }
        }

        private static byte[] EncryptSecret(byte[] data)
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                try
                {
                    return ProtectedData.Protect(data, null, DataProtectionScope.LocalMachine);
                }
                catch (PlatformNotSupportedException) { }
            }
            // Obfuscation fallback for simulation platforms (e.g. Linux dev machine)
            byte[] output = new byte[data.Length];
            for (int i = 0; i < data.Length; i++)
            {
                output[i] = (byte)(data[i] ^ 0x5A);
            }
            return output;
        }

        private static byte[] DecryptSecret(byte[] data)
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                try
                {
                    return ProtectedData.Unprotect(data, null, DataProtectionScope.LocalMachine);
                }
                catch (PlatformNotSupportedException) { }
            }
            // Obfuscation fallback
            byte[] output = new byte[data.Length];
            for (int i = 0; i < data.Length; i++)
            {
                output[i] = (byte)(data[i] ^ 0x5A);
            }
            return output;
        }

        public Task<AgentSettings> GetSettingsAsync(CancellationToken ct)
        {
            lock (_lock)
            {
                return Task.FromResult(_currentSettings);
            }
        }

        public async Task RefreshSettingsAsync(CancellationToken ct)
        {
            string url = $"{_serverUrl.TrimEnd('/')}/api/v1/config";
            
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _deviceToken);
                request.Headers.Add("X-Device-ID", _deviceId);

                var response = await _httpClient.SendAsync(request, ct);
                if (response.IsSuccessStatusCode)
                {
                    var settings = await response.Content.ReadFromJsonAsync<AgentSettings>(cancellationToken: ct);
                    if (settings != null)
                    {
                        lock (_lock)
                        {
                            _currentSettings = settings;
                        }

                        // Update local cache
                        string json = JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true });
                        await File.WriteAllTextAsync(_settingsCachePath, json, ct);
                    }
                }
            }
            catch
            {
                // In case of network errors, we gracefully degrade by keeping the current/cached settings
            }
        }

        public string GetDeviceId() => _deviceId;
        public string GetDeviceToken() => _deviceToken;
        public string GetServerUrl() => _serverUrl;
    }
}
