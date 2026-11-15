# Splurnk specification

## §splurnk-deployment-boundary Deployment boundary and multi-tier isolation

Splurnk ships as a single MIT-licensed package (`@plurnk/splurnk`) that operates unchanged across third-party self-hosted installations, isolated dark dogfooding (`dev.splurnk.app`), and the hosted public/enterprise service (`splurnk.app`).

| Aspect | Contract |
|---|---|
| Origin & bot neutrality | Public origin (`SPLURNK_PUBLIC_ORIGIN`), bot handle (`SPLURNK_BOT_HANDLE`), OIDC issuer (`SPLURNK_TELEGRAM_OIDC_ISSUER`), chat API origin (`SPLURNK_TELEGRAM_API_ORIGIN`), database path (`SPLURNK_DB_PATH`), and Plurnk endpoint (`SPLURNK_PLURNK_URL`) come exclusively from configuration ({§splurnk-configuration}), never hardcoded domain or bot literals. |
| Origin validation | `SPLURNK_PUBLIC_ORIGIN`, `SPLURNK_PLURNK_URL`, `SPLURNK_TELEGRAM_OIDC_ISSUER`, and `SPLURNK_TELEGRAM_API_ORIGIN` must be valid `http:` or `https:` URLs with no credentials, query string, hash, or trailing path segments beyond origin (`ConfigurationError` on malformed input). |
| Daemon separation | Splurnk's default Plurnk endpoint (`http://127.0.0.1:1067`) is distinct from an operator's personal Plurnk daemon (`127.0.0.1:1066`), and deployments isolate daemon persistence via `PLURNK_SERVICE_STATE_ROOT` ({§splurnk-daemon-posture}). |

## §splurnk-configuration Configuration floor and secret perimeter

All non-secret operational defaults live in `.env.defaults` and are read exclusively through `@plurnk/plurnk-meta` `Knob` without reader-local defaults.

| Knob | Floor value | Validation rule |
|---|---|---|
| `SPLURNK_HOST` | `127.0.0.1` | Non-empty bind host string. |
| `SPLURNK_PORT` | `3400` | Safe integer `1..65535` (`0` admitted in ephemeral test binds). |
| `SPLURNK_PUBLIC_ORIGIN` | `http://127.0.0.1:3400` | Canonical `http:` or `https:` origin (`<scheme>://<host>[:<port>]`). |
| `SPLURNK_STOP_TIMEOUT_MS` | `10000` | Safe integer `>= 1` milliseconds. |
| `SPLURNK_DB_PATH` | `data/splurnk.db` | Non-empty filesystem path or `:memory:`. |
| `SPLURNK_PLURNK_URL` | `http://127.0.0.1:1067` | Canonical `http:` or `https:` origin of the dedicated Plurnk daemon. |
| `SPLURNK_BOT_HANDLE` | `splurnkbot` | Bot handle without `@`, matching `^[A-Za-z][A-Za-z0-9_]{2,31}$`. |
| `SPLURNK_TELEGRAM_OIDC_ISSUER` | `https://oauth.telegram.org` | Canonical `http:` or `https:` origin. |
| `SPLURNK_TELEGRAM_API_ORIGIN` | `https://api.telegram.org` | Canonical `http:` or `https:` origin. |
| `SPLURNK_LOGIN_TTL_SEC` | `600` | Safe integer `>= 1` seconds (in-flight OIDC login transaction TTL). |
| `SPLURNK_SESSION_TTL_SEC` | `2592000` | Safe integer `>= 1` seconds (authenticated session TTL). |

Optional secret variables (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_OIDC_CLIENT_ID`, `TELEGRAM_OIDC_CLIENT_SECRET`, `SPLURNK_SESSION_SECRET`, `PLURNK_SECRET`) default to `null` when unset or blank, are supplied via gitignored `.env.keys` (`0600`) or process environment, and are never echoed in logs, diagnostics, or HTTP responses. Missing floor keys throw an assembled-floor `Error`; invalid values throw `ConfigurationError` naming the offending key.

## §splurnk-http-lifecycle HTTP listener, health, and shutdown settlement

| Request / Lifecycle | Contract |
|---|---|
| `GET /health` (active) | Answers `200 OK` (`application/json; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`) with `{"status":"ok","origin":"<SPLURNK_PUBLIC_ORIGIN>","botHandle":"<SPLURNK_BOT_HANDLE>"}`. |
| `GET /` (active) | Answers `200 OK` (`text/html; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`) with a semantic HTML document identifying the service and configured `@<SPLURNK_BOT_HANDLE>`. |
| `HEAD` on served routes | Answers the identical status and headers as `GET` with an empty body. |
| Unknown route | Answers `404` RFC 9457 Problem Details (`application/problem+json; charset=utf-8`, `type: "https://problems.plurnk.xyz/splurnk/not-found"`). |
| Unsupported method | Answers `405` RFC 9457 Problem Details (`Allow: GET, HEAD`, `type: "https://problems.plurnk.xyz/splurnk/method-not-allowed"`). |
| `stop()` / drain | Immediately flips new requests on all routes (including `/health`) to `503` Problem Details (`type: "https://problems.plurnk.xyz/splurnk/service-stopping"`, `retryable: true`) while awaiting in-flight handlers up to `SPLURNK_STOP_TIMEOUT_MS` before closing the listener; idempotent across repeated calls. |

## §splurnk-daemon-posture Dedicated Plurnk daemon posture and workspace RBAC

`config/plurnk.env` defines the committed, non-secret `plurnk-service` profile for Splurnk's dedicated Plurnk daemon (#3):

- **Subprocess lockout**: `PLURNK_EXECS_ONLY=` disables all subprocess executors (`sh`, `js`, `python3`, and any other installed runtime tags).
- **Ambient filesystem & Git denial**: `PLURNK_SERVICE_GIT_ALLOWED=0`, `PLURNK_SERVICE_GIT_AUTO=0`, `PLURNK_SERVICE_FILE_CREATE_SCOPE=none`, `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE=none`, and `PLURNK_MEMBERS_AUTO_ADD=0` prevent ambient repository ingestion and model-initiated host file creation.
- **Authenticated gate perimeter**: `PLURNK_AUTH=1`, `PLURNK_PORT=1067`, and `PLURNK_SERVICE_PROPOSALS=review` ensure all ACP and MCP access authenticates through OAuth 2.1 and routes workspace mutation proposals through the session owner.
- **Admin-only workspace mutation**: Only verified room administrators may modify a room workspace's `AGENTS.md` document or workspace folder; non-admin sessions are denied workspace file and Functionality mutations (#3).

## §splurnk-identity-oidc Telegram OpenID Connect authentication

Members sign in on the web through Telegram's standard OpenID Connect provider (`SPLURNK_TELEGRAM_OIDC_ISSUER`, default `https://oauth.telegram.org`) using Authorization Code with PKCE (`S256`), `state`, and `nonce`, requesting `openid profile` scopes:

| Endpoint / Boundary | Contract |
|---|---|
| `GET /auth/login` | Validates optional `?return=<local-path>` (default `/`), redirects `303` immediately when already signed in, or answers `503` Problem Details (`oidc-unconfigured`) when `TELEGRAM_OIDC_CLIENT_ID` / `TELEGRAM_OIDC_CLIENT_SECRET` are unset. Otherwise discovers OIDC metadata, seals `{ state, nonce, codeVerifier, redirectUri, returnTo, expiresAt }` into a single-use `HttpOnly; SameSite=Lax; Path=/auth` cookie (`__Secure-splurnk_login_<state>` under `https:`, `splurnk_login_<state>` under `http:`) for `SPLURNK_LOGIN_TTL_SEC`, and redirects `303 See Other` to `authorization_endpoint`. |
| `GET /auth/callback` | Clears the single-use transaction cookie immediately regardless of outcome, redeems the authorization code via `ClientSecretBasic`, cryptographically verifies the ID Token JWS signature against `jwks_uri` and `nonce` / `aud` / `iss` claims without calling a `UserInfo` endpoint, extracts immutable `sub`, optional `preferred_username`, `name`, and `https:` `picture`, and discards OIDC tokens. Upserts the member in SQLite, revokes any prior session on the request, persists `sha256(sid)` and a per-session CSRF token for `SPLURNK_SESSION_TTL_SEC`, sets `__Host-splurnk_session` (`splurnk_session` under `http:`) at `Path=/`, and redirects `303 See Other` to `returnTo`. |
| `POST /auth/logout` | Requires same-origin headers (`Origin` / `Sec-Fetch-Site`) and matching `_csrf` form token when a session is active, revokes the persisted session row, clears the session cookie (`Max-Age=0`), and redirects `303 See Other` to `/`. |

## §splurnk-chat-seam Modular chat adapter and Telegram boundary

External chat platforms integrate strictly through a transport-neutral `ChatAdapter` port (#1):

- **Group mentions only (`6.B`)**: Splurnk neither monitors nor participates in general group conversation; only messages explicitly tagging `@<SPLURNK_BOT_HANDLE>` dispatch a turn to the room session and reply in the room, alongside explicit outbound room alerts/notifications.
- **Outbound-only direct messages**: Direct messages from `@<SPLURNK_BOT_HANDLE>` deliver notifications, alerts, and check-ins only; interactive 1:1 chat with `splurnkbot` lives exclusively in the web application (`6.A`).
- **Room roster & admin discovery**: Room installation events, administrator queries, and verified member enrollment populate `(room, member, role)` state behind `ChatAdapter` (#1).

## §splurnk-workspace-sessions Group workspaces, peer sessions, and ACPv2 delivery

Each enrolled chat group maps to one isolated Plurnk workspace containing peer root sessions with no parent/child session hierarchy (#2):

- `<workspace>#room` handles `@<SPLURNK_BOT_HANDLE>` group-chat mentions (`6.B`).
- `<workspace>#u_<memberId>` binds 1:1 to that member's in-app chat window (`6.A`), also receiving wakes when the member submits/completes a `splurnkbot`-assigned task (`6.C`) or when `@plurnk/plurnk-schedule` targets that session (`6.D`).
- Any `SEND` or `DONE` emitted on `<workspace>#u_<memberId>` delivers to that member's chat stream over `@agentclientprotocol/sdk` and daemon notification observation (#2).

## §splurnk-schedule-authority Exclusive @plurnk/plurnk-schedule recurrence and wakeups

Splurnk maintains zero independent recurrence or cron engines (#4):

- Zoned RFC 5545 / 5-field cron parsing, normalization, timezone validation, and occurrence derivation consume `@plurnk/plurnk-schedule` exclusively.
- Scheduled agent check-ins, reminders, and recurring orchestration (`6.D`) execute exclusively through the workspace's `schedule` Functionality in `plurnk-service`.

## §splurnk-task-board Multi-room task board, mode navigation, and MCP surface

Authenticated members view a unified RFP-derived task stack across their enrolled rooms, create tasks via `[New]`, and toggle between the **Task** and **Chat** views (#5):

- Each task row presents room avatar, assignee avatar(s), task emoji, title, edit affordance, assigner badge, and active streak indicator (with bounties and Play artifact decks omitted from v1 under #6).
- Splurnk mounts an authenticated Streamable HTTP MCP server (`/mcp`) exposing room-scoped task inspection, mutation, and outbound notification tools to `splurnkbot`.
