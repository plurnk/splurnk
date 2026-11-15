# Security Policy

Security fixes target the current release line.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting for `plurnk/splurnk`:

1. open the repository's **Security** tab;
2. choose **Report a vulnerability**;
3. include affected versions, impact, reproduction, and any suggested fix.

If private reporting is unavailable, contact the repository owner privately
through their GitHub profile and request a secure reporting channel. Do not
send credentials, bot tokens, OAuth secrets, session cookies, or an unsanitized
Splurnk or PLURNK database.

A vulnerability in the PLURNK daemon or its extensions and modules belongs to
[`plurnk/plurnk-service`](https://github.com/plurnk/plurnk-service/security/policy),
which takes reports the same way.

## Scope

Useful reports include Splurnk exposing bot tokens, OIDC client secrets, session
secrets, or PLURNK daemon credentials; cross-room or cross-member task or chat
data disclosure; non-admin members mutating a room workspace's `AGENTS.md` or
workspace folder; forged webhook or OIDC callbacks; and vulnerable release
artifacts.
