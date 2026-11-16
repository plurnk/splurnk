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
| `SPLURNK_TELEGRAM_SET_WEBHOOK` | `0` | Boolean flag (`0` / `1`) controlling automatic `setWebhook` registration on startup when `TELEGRAM_BOT_TOKEN` is present. |
| `SPLURNK_ROOM_VERIFY_TTL_SEC` | `300` | Safe integer `>= 1` seconds between live `ChatAdapter` membership/role re-verifications. |
| `SPLURNK_LOGIN_TTL_SEC` | `600` | Safe integer `>= 1` seconds (in-flight OIDC login transaction TTL). |
| `SPLURNK_SESSION_TTL_SEC` | `2592000` | Safe integer `>= 1` seconds (authenticated session TTL). |

Optional secret variables (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_OIDC_CLIENT_ID`, `TELEGRAM_OIDC_CLIENT_SECRET`, `SPLURNK_SESSION_SECRET`, `PLURNK_SECRET`) default to `null` when unset or blank, are supplied via gitignored `.env.keys` (`0600`) or process environment, and are never echoed in logs, diagnostics, or HTTP responses. Missing floor keys throw an assembled-floor `Error`; invalid values throw `ConfigurationError` naming the offending key.

## §splurnk-http-lifecycle HTTP listener, health, and shutdown settlement

| Request / Lifecycle | Contract |
|---|---|
| `GET /health` (active) | Answers `200 OK` (`application/json; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`) with `{"status":"ok","origin":"<SPLURNK_PUBLIC_ORIGIN>","botHandle":"<SPLURNK_BOT_HANDLE>"}`. |
| `GET /` (active) | Answers `200 OK` (`text/html; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`) with a spartan semantic HTML document under {§splurnk-web-shell}. |
| `HEAD` on served routes | Answers the identical status and headers as `GET` with an empty body. |
| Unknown route | Answers `404` RFC 9457 Problem Details (`application/problem+json; charset=utf-8`, `type: "https://problems.plurnk.xyz/splurnk/not-found"`). |
| Unsupported method | Answers `405` RFC 9457 Problem Details (`Allow: GET, HEAD`, `type: "https://problems.plurnk.xyz/splurnk/method-not-allowed"`). |
| `stop()` / drain | Immediately flips new requests on all routes (including `/health`) to `503` Problem Details (`type: "https://problems.plurnk.xyz/splurnk/service-stopping"`, `retryable: true`) while awaiting in-flight handlers up to `SPLURNK_STOP_TIMEOUT_MS` before closing the listener; idempotent across repeated calls. |

## §splurnk-web-shell Spartan document shell, icons, and installation

Splurnk adopts the `@plurnk/plurnk-web` icon, logo, favicon, and native document shell contract (#9) with zero marketing or placeholder prose:

| Surface | Contract |
|---|---|
| Icons & licensing | Single Google Noto Emoji hamster SVG (`/icons/splurnk.svg`, glasses and `#148800` bow) for header, `<link rel="icon" type="image/svg+xml" sizes="any">`, and manifest (`purpose: "any"`, `sizes: "any"`), with zero raster fallback; `/icons/NOTO-NOTICE.txt` and `/icons/APACHE-2.0.txt` ship as public assets. Build generates opaque safe-circle `/icons/splurnk-maskable.svg` (`purpose: "maskable"`, `sizes: "any"`). |
| Manifest & metadata | `manifest.webmanifest` declares `id: "/"`, `start_url: "/"`, `scope: "/"`, `display: "standalone"`, `theme_color: "#148800"`, and `background_color: "#ffffff"`. HTML declares `robots: noindex, nofollow`, `referrer: same-origin`, `color-scheme: light dark`, monospace typography (`1.25` line height), and `65ch` measure. |
| Header & empty states | Mascot-only home link (`2ch` monospace scale, accessible `alt="Splurnk"`, `title="Home"`), horizontally scrollable room strip when enrolled, `2ch` member avatar and inline SVG `Sign out` control (`aria-label` + `title`); anonymous documents omit session controls. Empty containers render concise structural markers (`No rooms.`, `No tasks.`, `No messages.`) with zero filler prose. |

## §splurnk-daemon-posture Dedicated Plurnk daemon posture and workspace RBAC

`config/plurnk.env` defines the committed, non-secret `plurnk-service` profile for Splurnk's dedicated Plurnk daemon (#3):

- **Subprocess lockout**: `PLURNK_EXECS_ONLY=` disables all subprocess executors (`sh`, `js`, `python3`, and any other installed runtime tags).
- **Ambient filesystem & Git denial**: `PLURNK_SERVICE_GIT_ALLOWED=0`, `PLURNK_SERVICE_GIT_AUTO=0`, `PLURNK_SERVICE_FILE_CREATE_SCOPE=none`, `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE=none`, and `PLURNK_MEMBERS_AUTO_ADD=0` prevent ambient repository ingestion and model-initiated host file creation.
- **Authenticated gate perimeter**: `PLURNK_AUTH=1`, `PLURNK_PORT=1067`, and `PLURNK_SERVICE_PROPOSALS=review` ensure all ACP and MCP access authenticates through OAuth 2.1 and routes workspace mutation proposals through the session owner.
- **Admin-only workspace mutation**: Only verified room administrators may modify a room workspace's `AGENTS.md` document or workspace folder; non-admin sessions are denied workspace file and Functionality mutations (#3).

## §splurnk-identity-oidc Telegram OpenID Connect authentication

Members sign in on the web through Telegram's standard OpenID Connect provider (`SPLURNK_TELEGRAM_OIDC_ISSUER`, default `https://oauth.telegram.org`) using Authorization Code with PKCE (`S256`) and `state`, requesting `openid profile telegram:bot_access` scopes:

| Endpoint / Boundary | Contract |
|---|---|
| `GET /auth/login` | Validates optional `?return=<local-path>` (default `/`), redirects `303` immediately when already signed in, or answers `503` Problem Details (`oidc-unconfigured`) when `TELEGRAM_OIDC_CLIENT_ID` / `TELEGRAM_OIDC_CLIENT_SECRET` are unset. Otherwise discovers OIDC metadata, seals `{ state, codeVerifier, redirectUri, returnTo, expiresAt }` into a single-use `HttpOnly; SameSite=Lax; Path=/auth` cookie (`__Secure-splurnk_login_<state>` under `https:`, `splurnk_login_<state>` under `http:`) for `SPLURNK_LOGIN_TTL_SEC`, and redirects `303 See Other` to `authorization_endpoint`. |
| `GET /auth/callback` | Redirects `303` to `/` without redeeming `code` when no login transaction cookie is present and the browser already holds an active session; otherwise clears the single-use transaction cookie immediately regardless of outcome, redeems the authorization code via `ClientSecretPost` (mapping HTTP `400` and HTTP `200` `{"error":"invalid_grant"}` replies to `400 oidc-grant-invalid` and accepting `id_token`-only token responses), cryptographically verifies the ID Token JWS signature against `jwks_uri` and `aud` / `iss` claims without calling a `UserInfo` endpoint, extracts canonical Telegram `id` when present (else immutable `sub`), optional `preferred_username`, `name`, and `https:` `picture`, and discards OIDC tokens. Upserts the member in SQLite, revokes any prior session on the request, persists `sha256(sid)` and a per-session CSRF token for `SPLURNK_SESSION_TTL_SEC`, sets `__Host-splurnk_session` (`splurnk_session` under `http:`) at `Path=/`, and redirects `303 See Other` to `returnTo`. Browser `GET` / `HEAD` requests (`Accept: text/html`) receiving an `HttpError` render a spartan HTML recovery document while non-HTML callers receive RFC 9457 `application/problem+json`; `/auth/*` and `5xx` errors emit path-only diagnostics without query strings, cookies, or secrets. |
| `POST /auth/logout` | Requires same-origin headers (`Origin` / `Sec-Fetch-Site`) and matching `_csrf` form token when a session is active, revokes the persisted session row, clears the session cookie (`Max-Age=0`), and redirects `303 See Other` to `/`. |

## §splurnk-chat-seam Modular chat adapter, Telegram boundary, and room isolation

External chat platforms integrate strictly through a transport-neutral `ChatAdapter` port while enforcing hard per-room tenant boundaries (#1):

| Surface / Event | Contract |
|---|---|
| `POST /webhooks/telegram` | Answers `503` (`telegram-unconfigured`) when `TELEGRAM_BOT_TOKEN` is unset, `401` (`unauthorized-webhook`) when `X-Telegram-Bot-Api-Secret-Token` fails constant-time comparison against the HKDF-derived webhook token, and `200 OK` (`{"ok":true}`) on verified updates. When `SPLURNK_TELEGRAM_SET_WEBHOOK=1`, startup registers `${SPLURNK_PUBLIC_ORIGIN}/webhooks/telegram` with `allowed_updates: ["message", "my_chat_member", "chat_member"]`. |
| Group mentions only (`6.B`) | Group/supergroup messages without an explicit `@<SPLURNK_BOT_HANDLE>` `mention` or `bot_command` entity are discarded without database writes or replies. Tagged messages enroll/refresh the room and sender membership and dispatch to the room handler. |
| Outbound-only direct messages | Direct messages from `@<SPLURNK_BOT_HANDLE>` deliver notifications, alerts, and check-ins only; inbound private messages never open an AI turn and reply with a static pointer to `SPLURNK_PUBLIC_ORIGIN`. |
| Room lifecycle & roster sync | `my_chat_member` installation enrolls the room with a deterministic `plurnk_workspace` (`rm-<provider>-<hash>`), mints a 256-bit `join_code`, syncs human admins via `ChatAdapter.listRoomAdmins`, and posts the room join URL; removal deactivates the room; `migrate_to_chat_id` preserves the room across Telegram supergroup upgrades; `chat_member` updates live member roles and revocations. |
| `GET` / `POST /rooms/join/:joinCode` | `GET` prompts Telegram OIDC sign-in (`?return=/rooms/join/:joinCode`) when signed out or renders a CSRF-protected confirmation form when signed in (`404` on unknown/inactive `joinCode`). `POST` verifies same-origin + `_csrf`, calls `ChatAdapter.verifyRoomMember` live (`403 not-room-member` if absent from the external chat), persists `(room, member, role)`, and redirects `303` to `/?room=<roomId>`. |
| Multi-room isolation & admin rotation | `GET /?room=<roomId>` answers `404` unless the authenticated member is an active member of that active room (re-verifying via `ChatAdapter.verifyRoomMember` once `SPLURNK_ROOM_VERIFY_TTL_SEC` elapses and revoking access immediately if removed). `POST /rooms/:roomId/rotate-join-link` requires live-verified `admin` role (`404` to non-members, `403 admin-required` to non-admins). |

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
