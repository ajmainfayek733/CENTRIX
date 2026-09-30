namespace Agent.Core.Identity;

public interface IDeviceContextProvider
{
    DeviceContext Current { get; }
}
