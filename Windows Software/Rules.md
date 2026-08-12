# Rules to follow during developing the software

## Target Framework:
- .NET 10
- Windows Service
- C#

## Queue

If sync fails cache data into local machine. Keep log of synced sequence to avoid duplication. Clear local storage after synce.

---

## Design Principles

Build around:

- Where possible apply SOLID, DRY, KISS, YAGNi, ETC, AGILE.
- Single Responsibility Principle: Each component has one job.
- Dependency Inversion: Depend on abstractions.
- Immutable event models where practical.
- Asynchronous processing for persistence and networking.
- Clear separation between Windows integration, business logic, storage, and synchronization.

---

## Avoid these techniques

These behaviors significantly increase the likelihood of antivirus detection:

- DLL injection
- Process hollowing
- API hooking
- Reflective DLL loading
- Kernel drivers (unless absolutely necessary)
- Modifying browser memory
- Reading another process's memory
- Disabling antivirus
- Disabling Windows Defender
- Self-modifying code
- Heavy obfuscation or packing
- Hiding processes or windows
- Bypassing Windows security mechanisms

---

## Prefer official Windows APIs

For our requirements **only use documented Windows APIs** such as:

- Win32 APIs
- GetForegroundWindow
- GetWindowThreadProcessId
- GetWindowText
- EnumWindows
- Windows UI Automation (UIA)
- Windows Event Hooks
- WMI (where appropriate)
- ETW (Event Tracing for Windows), if suitable
- Standard .NET APIs
- Power APIs
- Session Notifications
- Restart Manager
- WTS APIs

Using documented APIs makes the application more maintainable and less suspicious.

---

## Build quality

Release builds should include:

- Release configuration
- ReadyToRun or NativeAOT if appropriate
- No debugging symbols in production packages (unless distributed separately)
- Proper version information
- Company name
- Product name
- File description

---

## Deployment

Design the agent to:

- Install through enterprise deployment tools (e.g., Microsoft Intune, Group Policy, Configuration Manager).
- Be code-signed.
- Run with the minimum required privileges.
- Clearly identify itself in Windows and documentation.
- Respect organizational policies and applicable privacy laws.

---

## Resource Usage

Application must meet especific system resource requirements

CPU -> less than 2%

---

## Admin is in control

Admin can turn off any feature, change feature capture timing.

example:
screenshotTime: 300s -> admin chnages to -> 1000s
attendace: true -> admin changes to -> false
Alert: true -> admin changes to -> false
Alert: default alert config -> admin changes to -> company policy

---

## Testing:
Unit tests
Integration tests
Stress tests
Fault injection
Recovery tests

---

## Coding Style:
Nullable enabled
File-scoped namespaces
Implicit usings
CA analyzers enabled
Treat warnings as errors

---

## Documentation:
Always cite Microsoft Learn.
Never invent Win32 behavior.

## Policy

1.