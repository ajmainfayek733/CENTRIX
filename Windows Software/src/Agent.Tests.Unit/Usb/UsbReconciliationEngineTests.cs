using Agent.Collectors.Usb;
using Agent.Native;

namespace Agent.Tests.Unit.Usb;

public class UsbReconciliationEngineTests
{
    private static UsbDriveSnapshot Drive(string pnpId, long? capacity = 16_000_000_000, params UsbVolumeSnapshot[] volumes) =>
        new(pnpId, "SERIAL123", "Generic Flash Drive", "Generic", capacity, volumes);

    [Fact]
    public void NewDeviceWithMedia_IsReportedAsInserted()
    {
        var previous = new Dictionary<string, UsbDriveSnapshot>();
        var current = new[] { Drive("USB\\VID_1234", volumes: [new UsbVolumeSnapshot("E:", "MyDrive", "FAT32")]) };

        var result = UsbReconciliationEngine.Reconcile(previous, current);

        Assert.Single(result.Inserted);
        Assert.Empty(result.Removed);
        Assert.Empty(result.MetadataChanged);
    }

    [Fact]
    public void DeviceNoLongerPresent_IsReportedAsRemoved()
    {
        var drive = Drive("USB\\VID_1234", volumes: [new UsbVolumeSnapshot("E:", "MyDrive", "FAT32")]);
        var previous = new Dictionary<string, UsbDriveSnapshot> { [drive.PnpDeviceId] = drive };

        var result = UsbReconciliationEngine.Reconcile(previous, []);

        Assert.Single(result.Removed);
    }

    [Fact]
    public void UnchangedDevice_ProducesNoEvents()
    {
        var drive = Drive("USB\\VID_1234", volumes: [new UsbVolumeSnapshot("E:", "MyDrive", "FAT32")]);
        var previous = new Dictionary<string, UsbDriveSnapshot> { [drive.PnpDeviceId] = drive };

        var result = UsbReconciliationEngine.Reconcile(previous, [drive]);

        Assert.Empty(result.Inserted);
        Assert.Empty(result.Removed);
        Assert.Empty(result.MetadataChanged);
    }

    [Fact]
    public void DriveLetterReassignedWhileConnected_IsReportedAsMetadataChanged()
    {
        var before = Drive("USB\\VID_1234", volumes: [new UsbVolumeSnapshot("E:", "MyDrive", "FAT32")]);
        var after = Drive("USB\\VID_1234", volumes: [new UsbVolumeSnapshot("F:", "MyDrive", "FAT32")]);
        var previous = new Dictionary<string, UsbDriveSnapshot> { [before.PnpDeviceId] = before };

        var result = UsbReconciliationEngine.Reconcile(previous, [after]);

        Assert.Single(result.MetadataChanged);
        Assert.Empty(result.Inserted);
        Assert.Empty(result.Removed);
    }

    [Fact]
    public void VolumeLabelChangedDuringSession_IsReportedAsMetadataChanged()
    {
        var before = Drive("USB\\VID_1234", volumes: [new UsbVolumeSnapshot("E:", "OldLabel", "FAT32")]);
        var after = Drive("USB\\VID_1234", volumes: [new UsbVolumeSnapshot("E:", "NewLabel", "FAT32")]);
        var previous = new Dictionary<string, UsbDriveSnapshot> { [before.PnpDeviceId] = before };

        var result = UsbReconciliationEngine.Reconcile(previous, [after]);

        Assert.Single(result.MetadataChanged);
    }

    [Fact]
    public void EmptyCardReaderWithNoMedia_NeverProducesAnInsertedEvent()
    {
        var emptyReader = Drive("USB\\VID_CARDREADER", capacity: 0);
        var previous = new Dictionary<string, UsbDriveSnapshot>();

        var result = UsbReconciliationEngine.Reconcile(previous, [emptyReader]);

        Assert.Empty(result.Inserted);
    }

    [Fact]
    public void RealDriveWithDelayedMount_IsStillReportedAsInserted_EvenWithNoVolumesYet()
    {
        // Delayed mount: the physical device (with known capacity) is present, but its volume
        // hasn't mounted yet - capacity, not volume presence, is what should trigger insertion.
        var delayedMountDrive = Drive("USB\\VID_1234", capacity: 16_000_000_000);
        var previous = new Dictionary<string, UsbDriveSnapshot>();

        var result = UsbReconciliationEngine.Reconcile(previous, [delayedMountDrive]);

        Assert.Single(result.Inserted);
    }

    [Fact]
    public void MultiplePartitionsOnOneDevice_AreTreatedAsOnePhysicalDeviceSession()
    {
        var drive = Drive(
            "USB\\VID_1234",
            volumes:
            [
                new UsbVolumeSnapshot("E:", "Part1", "NTFS"),
                new UsbVolumeSnapshot("F:", "Part2", "NTFS")
            ]);
        var previous = new Dictionary<string, UsbDriveSnapshot>();

        var result = UsbReconciliationEngine.Reconcile(previous, [drive]);

        var inserted = Assert.Single(result.Inserted);
        Assert.Equal(2, inserted.Volumes.Count);
    }

    [Fact]
    public void HubUnplugged_AllChildDevicesAreReportedRemoved()
    {
        var child1 = Drive("USB\\VID_HUBCHILD1", volumes: [new UsbVolumeSnapshot("E:", "Child1", "FAT32")]);
        var child2 = Drive("USB\\VID_HUBCHILD2", volumes: [new UsbVolumeSnapshot("F:", "Child2", "FAT32")]);
        var previous = new Dictionary<string, UsbDriveSnapshot>
        {
            [child1.PnpDeviceId] = child1,
            [child2.PnpDeviceId] = child2
        };

        // Hub unplugged: both children simply vanish from the next enumeration.
        var result = UsbReconciliationEngine.Reconcile(previous, []);

        Assert.Equal(2, result.Removed.Count);
    }

    [Fact]
    public void SameDeviceRemovedThenReinsertedQuickly_ProducesRemoveThenInsertAsSeparateSessions()
    {
        var drive = Drive("USB\\VID_1234", volumes: [new UsbVolumeSnapshot("E:", "MyDrive", "FAT32")]);
        var previous = new Dictionary<string, UsbDriveSnapshot> { [drive.PnpDeviceId] = drive };

        var removalResult = UsbReconciliationEngine.Reconcile(previous, []);
        Assert.Single(removalResult.Removed);

        var afterRemoval = new Dictionary<string, UsbDriveSnapshot>();
        var reinsertResult = UsbReconciliationEngine.Reconcile(afterRemoval, [drive]);
        Assert.Single(reinsertResult.Inserted);
    }
}
