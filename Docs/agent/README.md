# Agent

The .NET 10 Windows monitoring agent. Source: `Windows Software_v3/`.

Two executables by design - `Centrix.Service.exe` as LocalSystem in session 0, and
`Centrix.Host.exe` in the interactive user session. Session 0 has no desktop, so window
titles, idle time and screen capture are physically impossible there; the service on top provides
boot-time start, survival across logoff, supervision and a credential a standard user cannot read.

> `Agent/` and `Windows Software/` at the repository root are **abandoned** earlier attempts.
> Nothing here depends on them - see [../archive/README.md](../archive/README.md).

| Document | Contents |
|---|---|
| [architecture.md](architecture.md) | **Start here.** Process model, data flow, sync durability, privacy guarantees, on-disk layout, cross-repo contracts |
| [agent-core.md](agent-core.md) | `Agent.Core` - wire contracts, typed SQLite store, policy model, IPC framing, file logging |
| [agent-service.md](agent-service.md) | `Agent.Service` - enrollment, sync, USB/WMI, retention, host supervision |
| [agent-host.md](agent-host.md) | `Agent.Host` - collectors, alert engine, tray icon, disclosure window |
| [features.md](features.md) | The feature requirements this agent implements |

## Projects

| Project | Output | Role |
|---|---|---|
| `Agent.Core` | library | Shared contracts, storage, policy, IPC |
| `Agent.Service` | `Centrix.Service.exe` | LocalSystem service |
| `Agent.Host` | `Centrix.Host.exe` | WPF app in the user session |

Both executables publish self-contained, `win-x64`, single-file and **untrimmed** - trimming
breaks `System.Management`'s reflectively-resolved WMI types and silently disables USB collection.

---

## Related

- [../operations/agent-deployment.md](../operations/agent-deployment.md) - install, update, remove
- [../operations/diagnostics.md](../operations/diagnostics.md) - agent log locations and tracing
- [../architecture/telemetry-pipeline.md](../architecture/telemetry-pipeline.md) - where the agent sits in the whole path
- [../backend/ingest.md](../backend/ingest.md) - the server side of the sync contract
- [../reference/agent-api.md](../reference/agent-api.md) - the endpoints the agent calls
