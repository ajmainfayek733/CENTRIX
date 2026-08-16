using System;
using System.Threading;
using System.Threading.Tasks;
using Agent.Core;

namespace Agent.Collectors
{
    public class IdleStateCollector : IIdleDetector
    {
        private readonly IWin32Service _win32Service;

        public IdleStateCollector(IWin32Service win32Service)
        {
            _win32Service = win32Service ?? throw new ArgumentNullException(nameof(win32Service));
        }

        public Task<uint> GetIdleDurationMsAsync(CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            
            uint lastInputTick = _win32Service.GetLastInputTime();
            uint currentTick = _win32Service.GetTickCount();

            if (currentTick >= lastInputTick)
            {
                return Task.FromResult(currentTick - lastInputTick);
            }

            // Handles overflow of GetTickCount after 49.7 days
            return Task.FromResult((uint.MaxValue - lastInputTick) + currentTick);
        }
    }
}
