# Cross-tier contracts

The tiers have no build-time link. Nothing checks that the agent's C# record and the backend's
Zod schema still agree - a mismatch is discovered at runtime, as a 400 on every batch or a
column that is silently always null.

These are the places where a change on one side alone is a bug. Treat each as a single commit
touching every listed file.

---

## 1. Event field names and enums

**Agent** `Windows Software_v3/src/Agent.Core/Contracts/TelemetryEvents.cs`, `Enums.cs`
**Backend** `Backend/src/modules/ingest/ingest.dto.ts` (Zod schemas)
**Database** `Backend/prisma/schema.prisma`
**Dashboard** `Frontend/src/types/api.ts`

Enums are serialized as **strings** and the server rejects anything outside its own enum. A
rename on one side alone produces a 400 on every batch of that channel - and only that channel,
so the symptom is one feed going quiet while the rest keep flowing.

Adding a field is safe in one direction only: the agent may send a field the server does not
know (Zod strips it, so it is silently discarded), but the server cannot require a field the
agent does not send.

| Change | Safe? |
|---|---|
| Add an optional field, server first | Yes |
| Add a required field | No - deploy the agent first, then make it required |
| Rename a field | No - a two-repo commit, and old queued events on disk will now be rejected |
| Add an enum member, server first | Yes |
| Remove an enum member | No - queued events carrying it become poison and drop after 5 attempts |

**Watch the queue.** An agent can hold days of events written under the old contract. A rename
poisons everything already queued, not just new collection.

## 2. Channel path segments

**Agent** `TelemetryChannelExtensions.ToWireName` in `Agent.Core/Contracts/`
**Backend** `CHANNELS` in `Backend/src/modules/ingest/ingest.dto.ts`

The six segments in `POST /api/v1/events/{channel}`:

```
attendance   activity-metric   activity-session   browser-activity   usb-event   alert
```

An unknown channel is a 400 from `channelParamSchema` before any body parsing happens.

## 3. Screenshot multipart field name

**Agent** `BackendClient.ScreenshotFileFieldName` (`"file"`)
**Backend** `SCREENSHOT_FILE_FIELD` in `Backend/src/modules/ingest/upload.ts`

A mismatch means multer finds no file and the request fails validation while the JPEG sits in
the spool directory being retried forever. Screenshots stop; nothing else does.

## 4. Request body size - deliberately unequal

**Agent** `BackendClient.MaxRequestBytes` = 900 KB
**Backend** `JSON_BODY_LIMIT` in `Backend/src/config/env.ts` = 2 MB

This is the one contract that must **not** be equal. The agent's budget sits well under the
server's ceiling so that two things land in the headroom rather than in a 413:

- the difference between the agent's size estimate and the exact encoded size,
- a server limit lowered in configuration before agents have picked up the change.

The agent halves and retries on a 413 regardless, so a mismatch degrades throughput rather than
losing data. Keep the ratio; do not "tidy" the two numbers into agreement.

## 5. Realtime event names and payloads

**Backend** `Backend/src/realtime/events.ts`
**Dashboard** `Frontend/src/lib/realtime.ts`

Duplicated deliberately - the two tiers share no build. They are constants on both sides, so a
rename is greppable rather than hidden in string literals scattered through components.

A mismatch is silent: the emitter emits, nobody listens, and the dashboard simply stops updating
live while every number remains correct on refresh. There is no error anywhere.

| Direction | Events |
|---|---|
| Server -> dashboard | `telemetry:ingested`, `device:presence`, `device:presence-snapshot`, `policy:updated` |
| Dashboard -> server | `device:force-sync` |
| Server -> agent | `policy:updated`, `sync:force`, `device:deactivated` |
| Agent -> server | `hello`, `heartbeat` |

`RollupDeltaPayload` must carry the same twelve fields on both sides. A field present on one
side only is added as `undefined` into a running total and turns it into `NaN`.

## 6. Policy fields

**Database** `Policy` model in `Backend/prisma/schema.prisma` - the source of truth
**Agent** `Windows Software_v3/src/Agent.Core/Policy/AgentPolicy.cs`
**Dashboard** `Frontend/src/app/(dashboard)/settings/PolicyForm.tsx`

`GET /api/v1/policy` returns the **full document, never a diff**. Defaults live in three places
and must match: the Prisma column default, the C# record default (what the agent runs on before
its first successful fetch), and the pagination fallbacks in
`Backend/src/modules/report/pagination.ts`.

`version` is incremented by the backend on every write. The agent compares it on each heartbeat;
a change triggers a full policy fetch **and** a fresh consent prompt. Never ignore the version.

A field added to the schema but not to `PolicyForm.tsx` is invisible to admins and stays at its
default forever - which looks exactly like the feature not working.

## 7. API response envelope

Every dashboard endpoint returns `{ status, message, data }`; `apiGet`/`apiSend` in
`Frontend/src/lib/api-client.ts` unwrap `.data`. A handler that returns a bare object gives the
dashboard `undefined` rather than an error.

The agent API does **not** use this envelope - it returns endpoint-specific shapes documented in
[../reference/agent-api.md](../reference/agent-api.md).

---

## Checklist before changing any of the above

1. Which files in the table are you editing? Edit all of them.
2. Can an agent in the field still have events queued under the old contract? If yes, is the
   change backward-compatible, or will those events poison and drop?
3. Does the change need an ordered rollout - server first, or agent first?
4. Update [../reference/](../reference/) and the affected domain document in the same commit.
5. `cd Backend && npm test` covers the wire contract for channels and enums.

---

## Related

- [system-overview.md](system-overview.md) - what each tier is allowed to do
- [telemetry-pipeline.md](telemetry-pipeline.md) - where along the path each contract sits
- [../reference/agent-api.md](../reference/agent-api.md) - the wire format itself
- [../reference/configuration.md](../reference/configuration.md) - every policy field
