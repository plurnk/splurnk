# Splurnk: Social Plurnk

Read `../POSSUMTECH.md` when available in a PossumTech checkout, `ARCHITECTURE.md`
first for ownership boundaries, and the owning `SPEC.md` contract before changing
behavior.

## Implementation

1. Adapt Roblox Family Planner to Telegram.
2. Keep the Telegram seam modular (`ChatAdapter`) so that different chat interfaces can be used in the future ({§splurnk-chat-seam}).
3. MIT open-source project within the `plurnk/` family: maintain a strict boundary between the reusable open-source core (third parties running their own bots and domains), isolated dark/local dogfooding (`dev.splurnk.app`), and the hosted public/enterprise service at `splurnk.app` ({§splurnk-deployment-boundary}).
4. Demand clean, idiomatic seams from `plurnk-service` rather than working around deficiencies in Splurnk; improving and proving out Plurnk's enterprise integration, scheduling, notifications/ACP, and security configuration is half the goal of this repository.
5. Secrets and tokens live exclusively in gitignored `.env.keys` (`0600`) or the service environment, never in tracked files; non-secret configuration lives in `.env.defaults` and `config/plurnk.env` ({§splurnk-configuration}, {§splurnk-daemon-posture}).
6. First iteration omits Play/artifact decks (#6); bounties (#6) and Telegram Mini App surfaces (#7) are deferred until tracked design issues settle.

## User Journey

1. User adds `@splurnkbot` (or the deployment's configured bot handle) to a Telegram group.
2. User signs into `splurnk.app` with standard Telegram OIDC (`https://oauth.telegram.org`, {§splurnk-identity-oidc}).
3. User has an RFP-style screen with task buttons ({§splurnk-task-board}):

   `[room pfp] [assignee pfps] [task emoji] [title] [bounty $] [edit glyph] [assigner glyph] [streak glyph]`

   *(Note: `[bounty $]` is deferred under #6.)*
4. User can create new tasks with `[New]` button.
5. User can toggle between task screen and chat screen.
6. AI is only triggered when:
   - **6.A.** User chats directly with `splurnkbot` in the app chat window.
   - **6.B.** User explicitly tags `@splurnkbot` in the group chat (Splurnk neither monitors nor participates in general group chat, aside from explicit outbound notifications/alerts).
   - **6.C.** User completes/submits a `splurnkbot`-assigned task.
   - **6.D.** Plurnk's scheduling subsystem triggers it.
7. Telegram direct messages are outbound notifications, alerts, and check-ins only—never the interactive chat surface.

## Plurnk Engine

1. Rely entirely and exclusively on Plurnk's scheduling subsystem (`@plurnk/plurnk-schedule`) rather than maintaining an independent recurrence/scheduler layer ({§splurnk-schedule-authority}, #4).
2. Each group chat is its own Plurnk workspace with peer root sessions (no formal parent/child session hierarchy, {§splurnk-workspace-sessions}):
   - A room session handling `@splurnkbot` group-chat mentions.
   - A dedicated session per user tied to that user's app chat window, where any `SEND` or `DONE` is delivered to the user and any user message in the app chat window dispatches there (#2).
3. Connect Splurnk to Plurnk via idiomatic ACP v2 (`@agentclientprotocol/sdk`) and daemon notification seams, improving `plurnk-service` upstream wherever the integration surfaces gaps (#2).
4. Run against a dedicated, custom-configured Plurnk daemon profile (`config/plurnk.env`, disabling host `sh`/script executors and ambient filesystem/git access via Plurnk configuration knobs). Only room admins can modify the workspace `AGENTS.md` document and workspace folder ({§splurnk-daemon-posture}, #3).

## Business Model

Splurnk enables enterprises, organizations, and informal communities to assign and track tasks together, with `splurnkbot` playing a coordinating and organizing role through Plurnk.

1. Subscribe a group to Splurnk Premium on `splurnk.app` for a stronger AI model and larger token budget (#3).
2. Hosted bots, custom installation, and consulting contracts for Splurnk support.

## Ecosystem Discipline

- **Configuration authority.** Deployment choices belong in `.env.defaults`, read through `@plurnk/plurnk-meta` `Knob` with zero reader-local fallback ({§splurnk-configuration}). Do not hardcode `splurnk.app`, `dev.splurnk.app`, or `@splurnkbot` in application logic.
- **Persistence boundary.** `@possumtech/sqlrite` is the sole SQLite persistence substrate. Schema, migrations, and queries live in `.sql` files; SQL literals in `.ts` or `.js` files fail `npm run test:lint`. Released migrations are frozen.
- **Document and CSS boundary.** Semantic HTML and native controls own document structure; `on_the_money` (`OTM`) enhances documents without a parallel SPA shell. Keep CSS concerns in four files (`app-vendor.css` pinned Pico Classless, `app-structure.css` layout, `app-style.css` `#148800` brand accents and light/dark tokens, `app-state.css` attribute-driven visual state). Do not add dependencies for future work.
- **A rename is total.** When a concept's name changes, it changes everywhere in one landing: types, schema, methods, Problems, knobs, wire actions, spec tags, tests, fixtures, and docs.
- **Retired forms are erased.** A retired name, syntax, knob, dependency, protocol, or behavior leaves no trace, shim, or refusal handler in the living tree. History lives in Git and forge issues.
- **Specification tags.** Declare contracts once at a `SPEC.md` heading as `§lowercase-kebab` and cite them as `{§lowercase-kebab}`. `npm test` runs `plurnk-spec-check`; every deterministic `test()` title cites at least one `{§tag}`.
- **Live daemons and processes.** Never stop or restart a daemon you did not start (especially an operator's `:1066` `plurnk-service`), and select processes by PID, never by pattern or directory.
- **Forge and commits.** PossumTech Gitea (`origin`) is canonical; GitHub (`github`) is a downstream mirror (`git push --no-verify github origin/main:refs/heads/main`). Commit verified changes using single-line Conventional Commits (`<= 100` chars) with the registered agent as author (`agy <wikitopian+agy@pm.me>`) and the operator as GPG-signed committer, gated by `npm test` before pushing. Work lands from `<type>/<slug>` branches as signed `--no-ff` merges citing `(#N)`.
