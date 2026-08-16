using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Agent.Core;

namespace Agent.Collectors
{
    public class UsbDeviceCollector : IUsbDeviceCollector
    {
        private Action<UsbDeviceRecord>? _onChangeCallback;
        private Timer? _simulationTimer;
        private bool _isListening;
        private readonly string _deviceId;

        public UsbDeviceCollector(string deviceId)
        {
            _deviceId = deviceId;
        }

        public Task<IEnumerable<UsbDeviceRecord>> GetRecentUsbChangesAsync(CancellationToken ct)
        {
            return Task.FromResult<IEnumerable<UsbDeviceRecord>>(Array.Empty<UsbDeviceRecord>());
        }

        public void StartListening(Action<UsbDeviceRecord> onUsbChanged)
        {
            _onChangeCallback = onUsbChanged;
            _isListening = true;

            // In simulation/mock mode (or fallback), we periodically trigger a mock USB insert
            _simulationTimer = new Timer(SimulateUsbEvent, null, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(10));
        }

        public void StopListening()
        {
            _simulationTimer?.Dispose();
            _simulationTimer = null;
            _isListening = false;
        }

        private void SimulateUsbEvent(object? state)
        {
            if (!_isListening || _onChangeCallback == null) return;

            var action = new Random().Next(0, 2) == 0 ? "Connected" : "Disconnected";
            var record = new UsbDeviceRecord(
                DeviceId: _deviceId,
                DeviceName: "Cruzer Glide USB 3.0",
                Action: action,
                CapturedAt: DateTimeOffset.UtcNow
            );

            _onChangeCallback(record);
        }
    }
}
