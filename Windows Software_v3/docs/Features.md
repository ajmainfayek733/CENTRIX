# An enterprise employee monitoring application

A Windows client installed on company-owned workstations as Administrator Elevated that collects workplace productivity telemetry (attendance, application usage, active/idle time, browser navigation, screenshots, USB device activity) and enterprise security alerts, under full employee disclosure. This backend receives that telemetry, stores it, serves admin-controlled policy back to each device, and (out of scope for this spec) presumably powers a reporting dashboard. This Application will also be responsible to protect company assets against unauthorized access and security threats, intellectual property theft.

---

This Doc is represents the core features

## Device Information

The Device Information Service collects and maintains a unique hardware and system profile for each managed endpoint, enabling administrators to accurately identify, inventory, and manage workplace devices. By recording persistent device identifiers, operating system details, network hardware information, and agent version, the service provides a reliable foundation for asset management, troubleshooting, security auditing, and policy enforcement across the organization.

---

Data to collect

```
Id
DeviceID
DeviceName
SystemType
Edition
Version
DeviceMacAddress  : (since MAC is burned to device hardware. IP changes each time device starts)
AgentVersion
LastSeen
```

---

The collected device information helps administrators distinguish individual devices, monitor agent deployment status, track active endpoints, and make informed decisions regarding hardware upgrades, device replacement, maintenance, and lifecycle management. Using stable hardware identifiers, such as the device MAC address, ensures consistent device identification even when network configurations or IP addresses change.

---

## Attendace report

The Attendance Report Service records each employee's first login and last logout time for every workday, providing an accurate attendance record for payroll, reporting, and workforce analytics. It handles edge cases such as workstation lock/unlock, shutdown, restart, hibernate, sleep, and unexpected power loss by persistently updating the logout time and recording the corresponding session termination reason to ensure reliable daily attendance data.

---

Database schema

```
UserId
SessionId
LoginTime
LogoutTime
```

---

## Activity Level Metric

The Activity Score Service calculates a daily activity metric using the total number of keystrokes and mouse clicks, without recording the actual keys typed or user content. This privacy-preserving metric is used solely to evaluate individual activity levels and support productivity reporting.

---

Database schema

```
SessionId
KeyCount
MouseCount
MouseLeftKeyCount (optional)
MouseRightKeyCount (optional)
MouseMiddleKeyCount (optional)
MouseOtherKeyCount (optional)
DateTime
```

---

The Mouse Activity Log Service records left, right, middle, and additional mouse button clicks to measure user activity and support productivity analytics. It synchronizes with the Attendance Service to ensure accurate daily metrics and provides insights for ergonomic assessments and hardware procurement decisions.

---

## Activity Logs

The Activity Log Service continuously monitors the employee's foreground application to record which application is actively in use and the duration of each activity session. It detects user inactivity using a default 5-minute idle threshold, automatically distinguishing active work time from idle periods to ensure accurate productivity measurement. The collected activity data provides a reliable audit trail for workforce analytics, attendance reporting, and security investigations while maintaining minimal system overhead.

---

Database Schema

```
SessionId
ActivitySessionId
AppName
ProcessName
ExecutablePath
Type : [Application, Desktop, Locked, Idle, Sleeping, Disconnected]
WindowTitle
StartTime
EndTime
DurationSeconds
Reason : [UserInactivity, ScreenLock, Sleep, Disconnect]
ProductivityTag : [Productive, Unproductive, Blacklisted, Neutral]
```

This service will provide information to the administration for especific users working progress and will be responsible for the administration to take strategic decision.

---

## Browser Activity log

The Browser Activity Log Service monitors employee web browsing activity to measure productivity, maintain an auditable history of website usage, and detect policy violations or potential data exfiltration. It classifies websites based on organizational policies and generates real-time notifications when users access blacklisted or high-risk websites. The collected activity supports productivity reporting, security investigations, compliance requirements, and insider threat detection.

---

Database Schema

```
BrowserActivityId
ActivitySessionId : [FK]
Browser : [chrome, edge, firefox, brave, opera, etc]
BrowserVersion : Browser Version
ProfileName : BrowserProfile Used
Domain
RawUrl
WindowTitle: Browser Winodw title
PageTitle : Active Tab title
Protocol : HTTP, HTTPS
StartTime
EndTime
DurationSeconds
ProductivityTag : [Productive, Unproductive, Blacklisted, Neutral]
```

---

Using `ActivitySessionId` links each browser visits to the corresponding application session.

---

## USB Logs

Monitors USB device connection and removal events to support security, compliance, and asset auditing. The service primarily tracks removable storage devices (USB flash drives, external hard drives, SD card readers) and mobile devices connected via USB (e.g., Android and iOS devices).

The collected information enables administrators to:

- Audit USB device usage across managed endpoints.
- Detect unauthorized removable storage devices.
- Support company data protection and compliance requirements.
- Investigate potential data exfiltration incidents.
- Generate security reports and device usage history.

This service records device connection and removal events only. It does not inspect, access, or copy the contents of connected devices.

---

Database Schema

```
SessionId
EventType : [Connected, Disconnected]
DeviceType : [USB-Storage, Mobile-Device, HID, Other]
FriendlyName
Manufacturer
Model
SerialNumber
VendorId
ProductId
DriveLetter
VolumeLabel
CapacityBytes
FileSystem
EventTime
```

---

## Alert Notification

The Alert Notification Service delivers real-time desktop notifications based on configurable severity levels to promote productivity and enforce organizational policies. Alerts are triggered for prolonged idle time (30 min - Normal, 45 min - Moderate, 60 min - Severe) and immediately display High severity warnings when a user accesses a blacklisted application or website, with all events recorded for administrative review.

---

## Periodic ScreenShots

The Periodic Screenshot Service captures desktop screenshots at configurable intervals (e.g., every 10 minutes) to support productivity monitoring and security investigations. The feature is optional, disabled by default (for tesing this feature - enabled by default, will turn to disable during publish), and can be enabled or disabled through administrator-defined organizational policies.

---

## Configuring Policies

- All monitoring features are centrally managed and can be enabled, disabled, or reconfigured at any time through the administration portal, with policy changes synchronized to all agents.

- Alert thresholds, severity levels, and notification rules are configurable from the backend without requiring agent updates.

- Periodic screenshot capture intervals are fully configurable through backend policies and applied dynamically to managed devices.

- All activity data is persisted locally with session and timestamp information to ensure data integrity across restarts, shutdowns, and unexpected interruptions.

- If backend synchronization is unavailable, the agent securely stores data locally and automatically uploads pending records when connectivity is restored, deleting local copies only after successful synchronization.

---

## Device Auth

The Device Authentication Service registers each endpoint by sending its device information to the **POST /auth/device/{MacAddress}** API during startup. If the backend returns Authenticated = true, the agent begins synchronizing activity data after successfully passing a heartbeat check that verifies both backend availability and device authorization. If the authentication request fails due to server unavailability or network errors, the agent continuously retries the request using a resilient retry mechanism (with configurable retry intervals) until a valid response is received, ensuring reliable device registration without interrupting local data collection.
