using System.Text.Json;
using Agent.Collectors.Usb;
using Agent.Core.Policy;

namespace Agent.Alerts.Rules;

public sealed class UsbViolationRule : IAlertRule<UsbDeviceEvent>
{
    public bool ShouldEvaluate(UsbDeviceEvent telemetryEvent) => telemetryEvent.EventType == UsbEventType.Inserted;

    public Task<AlertEvaluationResult?> EvaluateAsync(UsbDeviceEvent telemetryEvent, PolicyDocument policy, CancellationToken cancellationToken)
    {
        if (!policy.Alert.Enabled || !policy.Usb.AlertOnInsertion)
        {
            return Task.FromResult<AlertEvaluationResult?>(null);
        }

        var context = JsonSerializer.Serialize(new
        {
            telemetryEvent.PnpDeviceId,
            telemetryEvent.Model,
            telemetryEvent.Manufacturer
        });

        return Task.FromResult<AlertEvaluationResult?>(new AlertEvaluationResult(
            AlertType.UsbViolation,
            AlertSeverity.High,
            "USB Device Connected",
            $"A USB storage device ({telemetryEvent.Model ?? "unknown model"}) was connected.",
            context));
    }
}
