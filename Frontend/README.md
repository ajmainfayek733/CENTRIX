# Frontend - monitoring dashboard

Next.js App Router. Port 3000. This tier owns no data - every value on screen comes from the
Express API in `Backend/`.

**Documentation lives in [`../Docs/frontend/`](../Docs/frontend/).**

| Document | Contents |
|---|---|
| [../Docs/frontend/README.md](../Docs/frontend/README.md) | Layout, server vs client components, data flow |
| [../Docs/frontend/session-and-auth.md](../Docs/frontend/session-and-auth.md) | The httpOnly cookie rule and the proxy routes |
| [../Docs/frontend/live-updates.md](../Docs/frontend/live-updates.md) | Sockets and bounded log scroll windows |
| [../Docs/frontend/design-system.md](../Docs/frontend/design-system.md) | Surfaces, palette, type and the component vocabulary |
| [../Docs/frontend/resilience.md](../Docs/frontend/resilience.md) | Behaviour when the backend is unreachable |
| [../Docs/README.md](../Docs/README.md) | Documentation index for the whole system |

```bash
cp .env.example .env.local    # MONITORING_API_URL=http://localhost:5000
npm run dev                   # http://localhost:3000
```

Start `Backend/` first - this dashboard renders server-side against it. Full instructions:
[../Docs/operations/running-the-stack.md](../Docs/operations/running-the-stack.md).

> `AGENTS.md` and `CLAUDE.md` in this directory are written and re-added by `next dev` itself.
> They are not documentation and are deliberately not moved into `Docs/`.
