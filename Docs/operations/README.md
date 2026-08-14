# Operations

Running the system, and fixing it when it misbehaves.

| Document | Use it when |
|---|---|
| [running-the-stack.md](running-the-stack.md) | Setting up locally, or verifying an install end to end |
| [backend-deployment.md](backend-deployment.md) | Deploying the API and onboarding a fleet |
| [agent-deployment.md](agent-deployment.md) | Installing, updating or removing the agent on workstations |
| [troubleshooting.md](troubleshooting.md) | **Something is wrong.** Indexed by symptom |
| [diagnostics.md](diagnostics.md) | You need logs, a trace, or evidence for a bug report |

---

## First moves when something breaks

```bash
curl http://localhost:5000/health
```

| Result | Means |
|---|---|
| `{"status":"ok"}` | API up **and** Postgres reachable |
| `503 database unreachable` | Process up, database is not answering |
| Connection refused | API is down |

Then:

1. **Which tier?** Health check, browser console, and whether other screens work.
2. **Which symptom?** [troubleshooting.md](troubleshooting.md) is indexed by symptom, not by
   component.
3. **What evidence?** [diagnostics.md](diagnostics.md) section 6 lists what to collect.

## Two things that look like bugs and are not

- **A device shows online but reports no activity.** Online means the *service* is
  authenticating. Attendance, activity, idle state, browser data and screenshots all come from the
  *host* process, which can be down independently. See
  [troubleshooting.md](troubleshooting.md) section 2.
- **An assigned-looking device produces no employee data.** Check the Devices screen for
  "Unassigned Devices". Unassigned telemetry is stored correctly and simply never reaches
  per-employee reports.

## Standing operational facts

| Fact | Consequence |
|---|---|
| Agents queue locally through an outage | Nothing is lost while the API is down; the queue drains on return |
| Agents back off exponentially | A fleet recovering from an outage does not arrive as a thundering herd |
| Agents upload sequentially | Never parallel, screenshots one at a time |
| Rate limits are per device | A healthy fleet never hits them; one agent doing so is stuck in a retry loop |
| The rollup is incremented, never recomputed | A double count is permanent - there is no repair pass |
| Screenshot storage is local to one replica | This is what blocks horizontal scaling |

---

## Related

- [../architecture/telemetry-pipeline.md](../architecture/telemetry-pipeline.md) - where data can be lost
- [../reference/configuration.md](../reference/configuration.md) - every setting
- [../architecture/decisions.md](../architecture/decisions.md) - why the constraints above exist
