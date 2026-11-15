# Splurnk

Social task coordination for Telegram groups (and future chat platforms), powered by
[`plurnk-service`](https://github.com/plurnk/plurnk-service).

Splurnk adapts the daily accountability loop of Roblox Family Planner to multi-room
communities, teams, and enterprises:

- **Modular chat seam (`{§splurnk-chat-seam}`):** Add `@splurnkbot` to a group chat; Splurnk stays silent during ordinary conversation, answers explicit `@splurnkbot` mentions, and uses Telegram DMs strictly for outbound notifications and check-ins.
- **Web task board & 1:1 agent chat (`{§splurnk-task-board}`, `{§splurnk-workspace-sessions}`):** Sign in with standard Telegram OIDC (`https://oauth.telegram.org`, `{§splurnk-identity-oidc}`), manage cross-room tasks, and chat with `splurnkbot` in a dedicated per-member workspace session.
- **Pure Plurnk engine (`{§splurnk-schedule-authority}`, `{§splurnk-daemon-posture}`):** Recurrence and scheduled wakeups rely exclusively on `@plurnk/plurnk-schedule`, running against a locked-down `plurnk-service` profile (`config/plurnk.env`) with host subprocess executors disabled.
- **Open-source core & hosted service (`{§splurnk-deployment-boundary}`):** MIT-licensed and configurable for self-hosted bots and domains, dark dogfooding (`dev.splurnk.app`), and the hosted service at `splurnk.app`.

## Requirements

- Node.js `>= 26`
- `@plurnk/plurnk-service` (for live agent workspaces and `@plurnk/plurnk-schedule`)

## Configuration

Non-secret defaults live in [`.env.defaults`](./.env.defaults) (`{§splurnk-configuration}`); committed Plurnk daemon posture lives in [`config/plurnk.env`](./config/plurnk.env) (`{§splurnk-daemon-posture}`).

Place deployment overrides in `.env` and credentials in `.env.keys` (`chmod 0600`, gitignored—see [`.env.example`](./.env.example)):

```sh
cp .env.example .env.keys
chmod 600 .env.keys
```

To enable web sign-in (`{§splurnk-identity-oidc}`), register `<SPLURNK_PUBLIC_ORIGIN>/auth/callback` under **Bot Settings → Web Login** in `@BotFather` and place `TELEGRAM_OIDC_CLIENT_ID`, `TELEGRAM_OIDC_CLIENT_SECRET`, and a random `SPLURNK_SESSION_SECRET` in `.env.keys`.

Validate the dedicated Plurnk daemon configuration against an installed `plurnk-service`:

```sh
plurnk-service config check --config=config/plurnk.env
```

## Development

```sh
npm install
npm test        # spec-check, SQL-boundary lint, typecheck, build, and 100%-covered unit tests
npm run dev     # watch-mode HTTP server using .env.defaults + optional .env / .env.keys
npm start       # production HTTP server from dist/
```

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — ownership boundaries, deployment tiers, and design rules
- [`SPEC.md`](./SPEC.md) — normative `{§tag}`-checked product and boundary contracts
- [`AGENTS.md`](./AGENTS.md) — contributor and agent operating guide
- [`SECURITY.md`](./SECURITY.md) — vulnerability reporting policy
