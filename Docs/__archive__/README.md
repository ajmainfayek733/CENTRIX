# Archive - abandoned documentation

> **Nothing in this folder is authoritative. Do not build on any of it.**
>
> These documents describe two earlier attempts at the Windows agent that were abandoned. They
> are kept for history - to explain why a decision was made, or to look up how something used to
> work - and for nothing else.

The live agent is **V3**, documented in [../agent/](../agent/) with source in
`Windows Software_v3/`.

| Folder | Describes | Source tree | Status |
|---|---|---|---|
| [v1-agent/](v1-agent/) | The first agent (`Core/`, `Collectors/`, `Infrastructure/`, `Host/` layering) | `Agent/` | Abandoned |
| [v2-windows-software/](v2-windows-software/) | The second attempt, with per-module specs and an API specification | `Windows Software/` | Abandoned |

Both source trees are still present at the repository root and are equally abandoned. They are
kept only so this history stays readable.

---

## Why they were abandoned

The user's assessment was that both were "old versions and have a lot of issues". V3 exists to fix
them, and reading or reusing code from either tree reintroduces the problems it was built to
solve.

The structural differences that matter:

| | v1 / v2 | V3 |
|---|---|---|
| Process model | Single process | SYSTEM service + user-session host (AD-01) |
| Telemetry storage | `payloadJson` envelope | Fully typed columns (AD-03) |
| Ingest route prefix | `/v1/ingest/*` | `/api/v1/*` |
| Device identity | MAC address | MachineGuid (AD-04) |

Decisions are recorded in [../architecture/decisions.md](../architecture/decisions.md).

## What replaced each document

| Archived | Superseded by |
|---|---|
| `v1-agent/agent.md` | [../agent/architecture.md](../agent/architecture.md) |
| `v1-agent/api.md` | Response conventions in [../reference/dashboard-api.md](../reference/dashboard-api.md); git and branch conventions in the root `README.md` |
| `v2-windows-software/docs/backend-api-specification.md` | [../reference/agent-api.md](../reference/agent-api.md), written from the live code |
| `v2-windows-software/docs/device-enrollment.md` | [../backend/ingest.md](../backend/ingest.md) section 1 |
| `v2-windows-software/docs/it-admin-deployment-guide.md` | [../operations/agent-deployment.md](../operations/agent-deployment.md) |
| `v2-windows-software/docs/running-the-agent.md` | [../operations/running-the-stack.md](../operations/running-the-stack.md) |
| `v2-windows-software/modules/*` | [../agent/features.md](../agent/features.md) and [../agent/agent-host.md](../agent/agent-host.md) |
| `v2-windows-software/Claude.md`, `Rules.md` | The root `CLAUDE.md` |

`v2-windows-software/docs/privacy-policy.md`, `terms-of-service.md` and
`monitoring_system_policy.md` are legal and policy text rather than engineering documentation.
They have **not** been superseded - review them against
[../product/product-spec.md](../product/product-spec.md) before reuse, since they were written for
the v2 feature set.

---

## Related

- [../agent/](../agent/) - the live agent documentation
- [../architecture/decisions.md](../architecture/decisions.md) - why V3 looks the way it does
- [../README.md](../README.md) - the documentation index
