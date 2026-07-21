# Agent API Contract

This document defines the HTTP contract used by the monitoring agent in [Agent/src](../../Agent/src). The agent does not expose a web API itself; it acts as a client and periodically sends telemetry to the backend.

## 1. Overview

The agent sends two kinds of requests:

- `GET /api/v1/config` to fetch runtime settings
- `POST /api/v1/ingest` to upload collected activity data

The current implementation uses the following headers:

- `Authorization: Bearer <device-token>`
- `X-Device-ID: <device-id>`
- `X-Idempotency-Key: <sha256-hash>`

> The agent currently serializes JSON using the default .NET serializer, so property names are sent in PascalCase unless the server or client changes the serializer configuration.

---

## 2. Configuration Endpoint

### 2.1 GET /api/v1/config

Used by the agent to retrieve runtime settings from the backend.

### Request headers

- `Authorization: Bearer <device-token>`
- `X-Device-ID: <device-id>`

### Success response

Status: `200 OK`

```json
{
  "AppTrackingEnabled": true,
  "UrlTrackingEnabled": false,
  "IdleDetectionEnabled": true,
  "IdleThresholdSeconds": 300,
  "AttendanceEnabled": true,
  "ScreenshotsEnabled": false,
  "ScreenshotIntervalMinutes": 10,
  "ActivityLevelEnabled": true,
  "UsbLoggingEnabled": false,
  "SampleIntervalSeconds": 15,
  "SyncIntervalSeconds": 60
}
```

### Expected behavior

- If the request succeeds, the agent stores the returned settings locally for later sampling loops.
- If the request fails, the agent falls back to its cached or default settings.

---

## 3. Ingest Endpoint

### 3.1 POST /api/v1/ingest

Used by the agent to upload one batch of collected telemetry.

### Request headers

- `Authorization: Bearer <device-token>`
- `X-Device-ID: <device-id>`
- `X-Idempotency-Key: <sha256-hash>`

### Request body

```json
{
  "DeviceId": "desktop-01",
  "ActivityLogs": [
    {
      "DeviceId": "desktop-01",
      "AppName": "Visual Studio Code",
      "WindowTitle": "Agent API Contract",
      "Domain": null,
      "IsIdle": false,
      "ActivityScore": 12,
      "CapturedAt": "2026-07-21T10:15:00Z"
    }
  ],
  "Screenshots": [
    {
      "DeviceId": "desktop-01",
      "CapturedAt": "2026-07-21T10:15:00Z",
      "EncryptedImageData": "base64-encoded-bytes"
    }
  ],
  "UsbLogs": [
    {
      "DeviceId": "desktop-01",
      "DeviceName": "USB Drive",
      "Action": "Connected",
      "CapturedAt": "2026-07-21T10:15:00Z"
    }
  ],
  "AttendanceRecords": [
    {
      "DeviceId": "desktop-01",
      "Date": "2026-07-21",
      "FirstLogin": "2026-07-21T08:00:00Z",
      "LastLogout": "2026-07-21T17:00:00Z",
      "TotalActiveSeconds": 28800
    }
  ]
}
```

### Field definitions

#### ActivityLog

| Field         | Type        | Required | Description                             |
| ------------- | ----------- | -------- | --------------------------------------- |
| DeviceId      | string      | yes      | Unique device identifier                |
| AppName       | string/null | no       | Active application name                 |
| WindowTitle   | string/null | no       | Active window title                     |
| Domain        | string/null | no       | Domain or URL context, currently null   |
| IsIdle        | boolean     | yes      | Whether the user was idle in the sample |
| ActivityScore | integer     | yes      | Activity level score from input events  |
| CapturedAt    | string      | yes      | UTC timestamp in ISO 8601 format        |

#### ScreenshotRecord

| Field              | Type   | Required | Description               |
| ------------------ | ------ | -------- | ------------------------- |
| DeviceId           | string | yes      | Device identifier         |
| CapturedAt         | string | yes      | UTC timestamp             |
| EncryptedImageData | string | yes      | Base64-encoded byte array |

#### UsbDeviceRecord

| Field      | Type   | Required | Description                   |
| ---------- | ------ | -------- | ----------------------------- |
| DeviceId   | string | yes      | Device identifier             |
| DeviceName | string | yes      | USB device name               |
| Action     | string | yes      | `Connected` or `Disconnected` |
| CapturedAt | string | yes      | UTC timestamp                 |

#### AttendanceRecord

| Field              | Type        | Required | Description                      |
| ------------------ | ----------- | -------- | -------------------------------- |
| DeviceId           | string      | yes      | Device identifier                |
| Date               | string      | yes      | Date in `YYYY-MM-DD` format      |
| FirstLogin         | string      | yes      | First login timestamp            |
| LastLogout         | string/null | no       | Last logout timestamp            |
| TotalActiveSeconds | integer     | yes      | Total active seconds for the day |

### Success response

Recommended status: `202 Accepted`

```json
{
  "status": "success",
  "message": "batch accepted"
}
```

### Error responses

- `400 Bad Request` — malformed payload or invalid fields
- `401 Unauthorized` — invalid or missing device token
- `403 Forbidden` — device not authorized
- `500 Internal Server Error` — server-side ingestion failure

### Expected behavior

- The backend should accept the batch and persist it durably.
- The backend should honor the idempotency key to avoid duplicate inserts on retries.
- If the request fails with `401` or `403`, the agent will stop retrying that batch and keep it queued locally.

---

## 4. Notes for Implementation

- The agent uses a local SQLite queue and only uploads data when the sync loop runs.
- The batch can contain a mix of activity logs, screenshots, USB events, and attendance records.
- Empty batches should be treated as a no-op and return success.
- The server should be tolerant of partial batches and validate each nested payload independently.

---

## 5. Recommended Backend Endpoints Summary

| Endpoint         | Method | Purpose                                   |
| ---------------- | ------ | ----------------------------------------- |
| `/api/v1/config` | GET    | Return runtime settings for the device    |
| `/api/v1/ingest` | POST   | Receive one synced batch of activity data |
