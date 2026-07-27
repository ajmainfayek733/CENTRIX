using Agent.Native;

namespace Agent.Collectors.Usb;

public sealed record UsbReconciliationResult(
    IReadOnlyList<UsbDriveSnapshot> Inserted,
    IReadOnlyList<UsbDriveSnapshot> Removed,
    IReadOnlyList<UsbDriveSnapshot> MetadataChanged);

/// <summary>
/// Pure diff between two point-in-time snapshots, keyed by PNPDeviceID. Run on every
/// reconciliation tick to "recover from missed WMI event / missed device notification" per the
/// spec — since it's a snapshot diff rather than an event stream, a missed intermediate tick
/// self-heals on the next one automatically.
/// </summary>
public static class UsbReconciliationEngine
{
    public static UsbReconciliationResult Reconcile(
        IReadOnlyDictionary<string, UsbDriveSnapshot> previous,
        IReadOnlyList<UsbDriveSnapshot> current)
    {
        // Capacity, not volume presence, distinguishes "empty card reader slot" (Size null/0)
        // from "a real drive whose volume hasn't mounted yet" (Size is known immediately even
        // before the filesystem mounts) — using volume presence alone would miss delayed mounts.
        var currentWithMedia = current
            .Where(HasMedia)
            .ToDictionary(d => d.PnpDeviceId);

        var insertedIds = currentWithMedia.Keys.Except(previous.Keys).ToList();
        var removedIds = previous.Keys.Except(currentWithMedia.Keys).ToList();
        var changedIds = currentWithMedia.Keys
            .Intersect(previous.Keys)
            .Where(id => !VolumesEqual(previous[id].Volumes, currentWithMedia[id].Volumes))
            .ToList();

        return new UsbReconciliationResult(
            insertedIds.Select(id => currentWithMedia[id]).ToList(),
            removedIds.Select(id => previous[id]).ToList(),
            changedIds.Select(id => currentWithMedia[id]).ToList());
    }

    private static bool HasMedia(UsbDriveSnapshot snapshot) => snapshot.CapacityBytes is > 0;

    private static bool VolumesEqual(IReadOnlyList<UsbVolumeSnapshot> a, IReadOnlyList<UsbVolumeSnapshot> b)
    {
        if (a.Count != b.Count)
        {
            return false;
        }

        var aSorted = a.OrderBy(v => v.DriveLetter, StringComparer.Ordinal).ToList();
        var bSorted = b.OrderBy(v => v.DriveLetter, StringComparer.Ordinal).ToList();

        for (var i = 0; i < aSorted.Count; i++)
        {
            if (aSorted[i] != bSorted[i])
            {
                return false;
            }
        }

        return true;
    }
}
