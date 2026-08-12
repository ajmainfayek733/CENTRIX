# Workforce Agent - Terms of Use

> **Before you use this document:** this is a working draft written to accurately describe what the Workforce Agent software actually does, based on its technical specification. It is **not legal advice** and has not been reviewed by qualified counsel. Have your legal/HR team review and adapt it - in particular the bracketed placeholders - before presenting it to employees or relying on it for compliance purposes.

**Company:** [Company Legal Name]
**Effective Date:** [Date]
**Applies to:** all employees, contractors, and other authorized users of company-owned computing devices on which the Workforce Agent is installed.

---

## 1. Purpose

The Workforce Agent ("the Agent") is workplace management software installed by [Company Legal Name] ("the Company") on company-owned Windows workstations to measure attendance, active working time, application and browser usage, and endpoint security events (such as USB device connections), for the purposes of operational efficiency, fair performance evaluation, and asset security.

The Agent is a disclosed, transparent monitoring tool. It is not covert surveillance software. Section 3 describes exactly what it does and does not do.

## 2. Scope and Acceptance

2.1 The Agent is installed only on devices owned and provided by the Company. It is not installed on personal devices.

2.2 By using a Company-provided device on which the Agent is installed, you acknowledge that this monitoring occurs. The Agent will not begin collecting data on a given user account until that acknowledgment is given through the on-screen notice presented at first use (or after a material policy change) - see the accompanying Privacy Policy for what is collected and why.

2.3 [If your organization requires a signed, physical or digital acknowledgment in addition to the in-app notice - e.g., as part of onboarding paperwork - describe that process here, and note that both records are retained per your data retention schedule.]

## 3. What the Agent Does and Does Not Do

### 3.1 Transparency guarantees

- The Agent is visible in Windows Task Manager and in Programs and Features (or Apps & Features) at all times. It does not hide its process, its icon, or its presence on the system.
- The Agent does not modify operating system files, disable security software, or attempt to gain elevated privileges beyond what is required for its documented functions.
- The Agent contains no remote-control, remote shell, or remote file-access capability. Company IT/security staff cannot use it to view your screen live, take control of your device, or browse your files.

### 3.2 What is collected

- Login, logout, lock, unlock, and idle/active time.
- The name, window title, and duration of applications you use in the foreground.
- The domain and URL of websites visited in a supported browser.
- Periodic screenshots of your screen - **only if enabled by your administrator**; disabled by default.
- USB storage device connection and disconnection events.
- System and security events needed to keep the Agent itself running correctly (e.g., service restarts).

### 3.3 What is never collected

- The content of what you type (no keystroke logging of content - only that input occurred, not what it was).
- Personal email, private messages, or personal social media content.
- Login credentials, passwords, or the contents of personal accounts.
- Any activity when you are not logged into the Company device with your work account, subject to Section 5.

### 3.4 Working hours and overtime

Standard working hours are [08:00-17:00 local time, Monday-Friday, admin-configurable]. Activity outside these hours is recorded as overtime for reporting purposes and is not, by itself, treated as a policy violation unless your administrator has separately configured such alerts.

## 4. Acceptable Use of Company Devices

4.1 You may not attempt to disable, uninstall, tamper with, or circumvent the Agent. Attempting to do so may itself generate a security alert and may be treated as a violation of Company IT policy, subject to the same disciplinary process as any other IT policy violation.

4.2 You may not use a Company device to attempt to defeat the Agent's monitoring through automation (e.g., software or hardware that simulates keyboard/mouse input to appear active). The Agent includes detection capability for this ("possible automation" / "suspicious activity" flags), and misuse will be handled per Company policy.

4.3 Connecting personal USB storage devices to Company equipment is subject to your organization's separate device-and-media policy [reference that policy here]; the Agent will log such connections regardless of whether they are otherwise permitted.

## 5. Multiple Users, Shared Devices, and Remote Access

5.1 If a device is used by more than one Windows account (e.g., IT support logging in under an administrative account), the Agent records activity per Windows account (identified by Security Identifier), not per physical device alone.

5.2 Remote Desktop sessions are monitored the same as console (in-person) sessions, distinguished internally for accuracy but subject to the same policy.

## 6. Alerts and Notifications

6.1 Certain conditions (e.g., extended idle time, access to a company-restricted website category, if configured) generate an on-screen notification to you at the time they occur, so you are aware that an event has been logged. The Agent does not generate silent, undisclosed alerts about your individual activity that you are not shown.

6.2 Alerts are also visible to designated Company administrators for operational and security purposes.

## 7. Data Retention, Access, and Your Rights

See the accompanying **Privacy Policy** for full detail on what is retained, for how long, and how to exercise your data protection rights (including access, correction, and deletion requests) under applicable law [Singapore PDPA; GDPR, where applicable to remote or offshore staff].

## 8. Changes to These Terms

The Company may update these Terms and the associated monitoring policy from time to time. Material changes will trigger a renewed on-screen acknowledgment before the updated policy takes effect on your device. The version of the policy in effect at any given time is recorded against your acknowledgment for audit purposes.

## 9. Contact

Questions about this policy, or requests relating to your monitored data, should be directed to: [Data Protection Officer / HR contact / IT contact - name, email].

---

*This document should be read together with the Workforce Agent Privacy Policy, which governs the specific data protection commitments made regarding information collected by this software.*
