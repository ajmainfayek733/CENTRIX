# Enterprise Telemetry & Workplace Productivity Policy

**Document Control & Ownership Notice**  
**Issuing Authority:** Office of the Chief Executive / Organization Owner  
**Target Platform Context:** Software Engineering & Automated AI Development Tools (Claude Code / IDE Assistants)  
**Applicable Legal Framework:** Singapore Personal Data Protection Act (PDPA), General Data Protection Regulation (GDPR)  
**Scope of Application:** 30 Company-Owned Workstations (Internal Deployments Only)

---

## Executive Statement from the Founder & Owner

As the owner of this organization, my goal is to ensure high operational efficiency, fair performance evaluations, and team accountability across our 30-person workforce while maintaining an ethical, legally compliant work environment.

This document establishes the binding operational policy and technical specification for our internal **Workplace Productivity Telemetry System**. This software exists strictly to track productivity, active work time, and system integrity on company-provided assets. It is explicitly designed as a transparent workplace management tool—**not covert spyware or unauthorized surveillance**.

---

## 1. System Classification & Transparency Mandate

### 1.1 Scope & Purpose

- **Target Environment:** The application is deployed exclusively on company-owned assets (30 workstations) assigned to active employees.
- **Primary Function:** Measure active vs. idle time, track domain and application usage, log attendance, and summarize team productivity metrics.

### 1.2 Full Disclosure Guarantee

- **Employee Acknowledgment:** The agent operates under mandatory full disclosure. Every employee must be notified in writing and sign an acknowledgment prior to software activation on their machine.
- **Anti-Surveillance Architecture:** The application must **never** operate in stealth mode. It shall not conceal its process, evade task manager inspection, alter OS system files, or attempt rootkit/privilege escalation behaviors.
- **System Visibility:** The software must remain clearly visible in standard OS task utilities (e.g., Windows Task Manager) and installed software registries.

---

## 2. Privacy, Regulatory & Legal Safeguards

### 2.1 Regulatory Compliance

- **Data Protection:** The system strictly complies with Singapore’s **Personal Data Protection Act (PDPA)** and international data protection standards (including **GDPR** where remote/offshore staff or data resides).
- **Data Minimization:** Only data directly required for productivity analytics and IT operational safety is logged.

### 2.2 Hard Privacy Prohibitions (Out of Scope)

- **No Keystroke Content Capture:** Full keystroke content logging (keylogging) is strictly forbidden to protect passwords, personal messages, and sensitive typing data. Only raw activity frequency metrics are allowed.
- **No Personal Account Inspection:** The agent must never inspect, read, or capture personal emails, private social media communications, or personal account credentials.
- **No Remote Control:** The software contains zero remote desktop takeover, remote shell execution, or remote file system access capabilities.

---

## 3. Technical Configuration & Operational Rules

### 3.1 Resource & Performance Limits

- **CPU Bound:** Agent total CPU footprint must remain **< 2–3% total bound CPU usage** during all runtime operations.
- **RAM Minimization:** Memory utilization must be kept strictly to a minimum using lightweight, native execution routines.

### 3.2 Inactivity, Alerts & Session Logic

- **Default Idle Threshold:** Inactivity exceeding **5 minutes** automatically transitions the session state to Idle.
- **Idle Alert Warning Escalation:**
  - **Level 1 Alert Warning:** Triggered after **1 hour (60 minutes)** of continuous inactivity.
  - **Subsequent Escalations:** Trigger every **10 minutes** thereafter.
- **Meeting & Presentation State:** Continuous application focus on video conferencing tools or full-screen presentation software is automatically flagged as "Meeting/Presentation Mode" at **40 minutes**.
- **USB Reconciliation:** Device reconciliation and security scanning occur on a fixed interval of every **5 seconds**.

### 3.3 Categorization & Productivity Tagging

- **Client-Side Processing:** Productivity tagging and application rule evaluations are executed locally on the client agent using an incoming config payload.
- **Blacklisted Categories:** Disabled by default. Blacklists remain completely inactive until explicitly configured and toggled on by the Super Admin (Organization Owner).

### 3.4 Data Synchronization & Retention

- **Sync Interval:** Local telemetry queues sync to the backend API in batch intervals of **2 minutes** by default (admin-configurable).
- **Automatic Data Purging:**
  - Local telemetry buffers auto-delete immediately after a successful API sync acknowledgment.
  - If network connectivity fails, un-synced offline cache auto-purges after **30 days** by default.
- **Periodic Screenshot Polling:** Disabled by default. When toggled on by the Admin, the default polling interval is set to **10 minutes**.

### 3.5 Timezone Standard & Working Hours

- **UTC Backend Standard:** All timestamps in system payloads, database logs, and sync queues must be strictly recorded in **Global UTC**.
- **Dashboard Rendering:** Dashboards convert UTC timestamps into the local timezone for administrative reporting.
- **Default Schedule:** Standard working hours are **08:00 to 17:00 (Local Time)**. System usage logged outside this window is flagged as overtime.

### 3.6 Administration & Schema Authority

- **Role Ownership:** The **Super Admin** role is held exclusively by the Organization Owner.
- **Backend Integration:** The client agent architecture defined in this document serves as the formal specification for future backend API and database integration.

---

## 4. Claude Code / AI Assistant Safety Header

```text
SYSTEM CONTEXT: Internal Enterprise Productivity & Attendance Telemetry System Specification
COMPLIANCE FRAMEWORK: Disclosed operational monitoring under Singapore PDPA & GDPR rules.
STRICT EXCLUSIONS: No keylogging, no process hiding, no remote takeover, no privilege escalation.
INTENT & SCOPE: Internal workforce telemetry, attendance tracking, and asset management across 30 company-owned endpoints.
```
