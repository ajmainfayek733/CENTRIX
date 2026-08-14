> **ARCHIVED - NOT AUTHORITATIVE.** This document describes an abandoned version of the
> agent. It is kept for history only. Do not build on it.
> The live documentation index is [../../../README.md](../../../README.md); see
> [../../../archive/README.md](../../../archive/README.md) for what superseded this file.

---

# Workforce Agent - Privacy Policy

> **Before you use this document:** this is a working draft describing the actual data practices of the Workforce Agent software, based on its technical specification, written to align with the general principles of Singapore's Personal Data Protection Act (PDPA) and the EU/UK GDPR (for any remote or offshore staff, or where data may be accessed from those jurisdictions). It is **not legal advice**. Data protection obligations depend on your specific jurisdictions, workforce composition, and how you configure the software - have qualified counsel and/or your Data Protection Officer review and finalize this before publishing it to employees.

**Company:** [Company Legal Name]
**Effective Date:** [Date]
**Policy Version:** [tracked automatically by the Agent - see section 9]

---

## 1. Who This Policy Covers

This policy applies to employees, contractors, and other individuals who use a device owned by [Company Legal Name] on which the Workforce Agent monitoring software is installed. It describes what personal data the Agent collects, why, how it is protected, how long it is kept, and what rights you have over it.

## 2. What We Collect and Why

We collect only what is directly required for productivity analytics, attendance record-keeping, and IT/security operations on Company-owned assets. Each category below states its specific purpose.

| Category                 | What is collected                                                                                                                           | Purpose                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attendance**           | Login, logout, screen lock/unlock, and sleep/resume timestamps                                                                              | Calculating hours present and worked; attendance record-keeping                                                                                      |
| **Active vs. idle time** | Whether you are actively using the device (keyboard/mouse/touch input, or high CPU activity such as compiling or rendering) versus idle     | Distinguishing genuine working time from time away from the keyboard; avoiding misclassifying meetings, presentations, or compute-bound work as idle |
| **Application usage**    | The name, window title, and duration of the application in the foreground                                                                   | Understanding how work time is spent across tools; productivity classification (see section 3)                                                              |
| **Browser activity**     | The domain and URL of websites visited in a supported browser                                                                               | Productivity classification; enforcing acceptable-use policy where a website restriction list is configured                                          |
| **Screenshots**          | Periodic images of your screen - **only if your administrator has enabled this feature**; disabled unless explicitly turned on              | Visual verification of work activity, where enabled                                                                                                  |
| **USB device activity**  | Connection/disconnection of USB storage devices, and identifying information about the device (make, model, capacity) - not the files on it | Data-loss prevention and endpoint security                                                                                                           |
| **Security alerts**      | System-generated notices (e.g., extended idle time, restricted-site access, USB connection, if configured)                                  | Operational and security oversight, and to notify you when such an event has been logged                                                             |
| **Consent record**       | The fact and date that you acknowledged this policy, and which version                                                                      | Proof of notice, for compliance purposes                                                                                                             |

### What we explicitly do not collect

- **Keystroke content.** We do not log what you type - passwords, messages, or any other typed content. Only the fact that input activity occurred (for idle-detection purposes) is used, never its content.
- **Personal account contents.** We do not read personal email, private messaging, or personal social media content, even if accessed on a Company device.
- **File contents.** USB monitoring records that a device was connected, not the files transferred to or from it.
- **Off-hours/off-device activity.** The Agent only runs on Company-owned devices and only collects data while you are logged into your work account on that device.

## 3. Productivity Classification

Administrators may configure a list mapping applications or websites to productivity categories (e.g., "Productive," "Neutral," "Unproductive"). This classification is applied automatically based on the application/site in use - it is not based on the content of your work, your communications, or any manual review of your individual activity by another person as a matter of routine.

## 4. Legal Basis for Processing

- **Legitimate interest / contractual necessity**: monitoring is necessary to manage the employment relationship, verify attendance, and protect Company assets and data, consistent with [Singapore PDPA's provisions for employee data processed in the ordinary course of employment / GDPR Article 6(1)(f) legitimate interest, or (b) contractual necessity, as applicable].
- **Consent / notice**: independent of the above legal bases, you are notified before monitoring begins on your account and asked to acknowledge this policy, both as a matter of transparency and, where required by law, as a condition precedent to specific processing activities (e.g., screenshot capture, where enabled).

Where members of your workforce are located outside Singapore, or where data may be accessed from outside Singapore (e.g., a backend hosted in another jurisdiction), GDPR or other local data protection law may apply in addition to the PDPA; section 8 addresses international transfer.

## 5. Data Minimization and Retention

- Data is retained locally on your device only until it is successfully transmitted to the central backend, at which point it is deleted from the device.
- If your device is offline and cannot transmit data, it is held locally for up to **30 days** (organization-configurable) before being automatically discarded - it is not held indefinitely on the device.
- Retention of data on the central backend after receipt is set by [Company Legal Name]'s data retention schedule: **[retention period - to be defined by the organization; not determined by the Agent software itself]**. We recommend defining a retention period no longer than necessary for the stated purposes in section 2, with periodic deletion or anonymization thereafter.
- Screenshots, where enabled, follow the same retention principles and are encrypted at rest both on the device and expected to be encrypted at rest on the backend.

## 6. Security Measures

- All data in transit between your device and the backend is encrypted using TLS.
- Data cached locally on your device (before transmission) is encrypted at rest.
- Screenshots, where enabled, are encrypted separately from other cached data before being written to disk.
- Access credentials used by the software to authenticate to the backend are stored using Windows' built-in data protection mechanisms, not in plain text.
- Access to collected data on the backend is restricted to authorized personnel with a legitimate business need (e.g., HR, IT/security, direct management), consistent with the principle of least privilege. [Company should define and insert its specific internal access-control policy here.]

## 7. Who Has Access to Your Data

- **Your manager and HR**, for performance and attendance purposes, per Company policy.
- **IT and security personnel**, for endpoint security and policy enforcement (e.g., investigating a security alert).
- **The Company's designated system administrator(s)**, who configure monitoring policy (thresholds, feature toggles, website restrictions) - referred to in the technical documentation as the Super Admin / Organization Owner role.
- We do not sell your data or share it with third parties for advertising or marketing purposes.
- [If a third-party hosting provider, analytics vendor, or backend operator will process this data on the Company's behalf, name them here and confirm a data processing agreement is in place.]

## 8. International Data Transfer

If any personal data is transferred outside Singapore (for example, because backend infrastructure is hosted in another country, or because remote/offshore staff are monitored from there), the Company will ensure such transfer complies with the PDPA's data transfer requirements and, where GDPR applies, an appropriate transfer mechanism (e.g., Standard Contractual Clauses, an adequacy decision, or another approved safeguard). [Insert specifics once backend hosting location is finalized.]

## 9. Notice of Changes

This policy is versioned. Whenever [Company Legal Name] materially changes what is collected or why, the Agent will present the updated notice to you and require a fresh acknowledgment before monitoring continues under the new policy. Your acknowledgment history (which version, and when) is retained as your consent record.

## 10. Your Rights

Subject to applicable law (PDPA and, where applicable, GDPR), you may have the right to:

- **Access** the personal data we hold about you.
- **Correct** inaccurate data.
- **Request deletion** of your data, subject to our legitimate need to retain employment and security records for the periods required by law or legitimate business purposes.
- **Withdraw consent**, where processing is based on consent rather than another legal basis - noting that some processing (e.g., attendance records) may continue to be required as a condition of your employment or under separate legal obligation even if you withdraw consent to this notice.
- **Lodge a complaint** with Singapore's Personal Data Protection Commission (PDPC) or, where GDPR applies, your relevant national data protection authority.

To exercise any of these rights, contact: [Data Protection Officer name/email].

## 11. Data Breach Notification

In the event of a data breach involving your personal data that poses a risk of significant harm, the Company will notify affected individuals and the relevant authority (e.g., Singapore's PDPC) in accordance with applicable law and within the required timeframe.

## 12. Contact

For questions about this Privacy Policy or how your data is handled:

**Data Protection Officer:** [Name]
**Email:** [Email]
**Address:** [Company address]

---

_This document should be read together with the Workforce Agent Terms of Use, which governs acceptable use of the software and Company devices on which it runs._
