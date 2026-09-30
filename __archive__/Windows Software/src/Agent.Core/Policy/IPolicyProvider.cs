namespace Agent.Core.Policy;

public interface IPolicyProvider
{
    PolicyDocument Current { get; }

    event EventHandler<PolicyDocument>? PolicyChanged;
}
