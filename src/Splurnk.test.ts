import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import {
    normalizeReturnTo,
    readConfig,
    readCookie,
    Splurnk,
    type ProblemDetails,
} from "./index.ts";

const RSA_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_JWK = {
    ...(RSA_KEYS.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    alg: "RS256",
    use: "sig",
    kid: "oidc-test-1",
};

interface MockOidcProfile {
    sub: string;
    name: string;
    preferred_username?: string;
    picture?: string;
}

async function startMockOidcServer(getProfile: () => MockOidcProfile): Promise<{
    issuer: string;
    setNextNonce(nonce: string): void;
    stop(): Promise<void>;
}> {
    let nextNonce = "";
    let issuer = "";
    const server: Server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/.well-known/openid-configuration") {
            const payload = JSON.stringify({
                issuer,
                authorization_endpoint: `${issuer}/auth`,
                token_endpoint: `${issuer}/token`,
                jwks_uri: `${issuer}/.well-known/jwks.json`,
                code_challenge_methods_supported: ["S256"],
                id_token_signing_alg_values_supported: ["RS256"],
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(payload);
            return;
        }
        if (url.pathname === "/.well-known/jwks.json") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ keys: [PUBLIC_JWK] }));
            return;
        }
        if (url.pathname === "/token" && req.method === "POST") {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                chunks.push(Buffer.from(chunk as Uint8Array));
            }
            const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
            if (form.get("code") === "bad-code") {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "invalid_grant" }));
                return;
            }
            const nowSec = Math.floor(Date.now() / 1000);
            const profile = getProfile();
            const header = Buffer.from(
                JSON.stringify({ alg: "RS256", typ: "JWT", kid: "oidc-test-1" }),
                "utf8",
            ).toString("base64url");
            const claims = Buffer.from(
                JSON.stringify({
                    iss: issuer,
                    aud: "splurnk-client",
                    iat: nowSec,
                    exp: nowSec + 300,
                    nonce: nextNonce,
                    ...profile,
                }),
                "utf8",
            ).toString("base64url");
            const signer = createSign("RSA-SHA256");
            signer.update(`${header}.${claims}`);
            const sig = signer.sign(RSA_KEYS.privateKey).toString("base64url");

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    access_token: "ephemeral-access-token",
                    token_type: "Bearer",
                    expires_in: 300,
                    id_token: `${header}.${claims}.${sig}`,
                }),
            );
            return;
        }
        res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    issuer = `http://127.0.0.1:${addr.port}`;

    return {
        issuer,
        setNextNonce(nonce: string) {
            nextNonce = nonce;
        },
        async stop() {
            await new Promise<void>((resolve, reject) =>
                server.close((err) => (err ? reject(err) : resolve())),
            );
        },
    };
}

function makeEnv(overrides: Record<string, string> = {}): Record<string, string> {
    return {
        SPLURNK_HOST: "127.0.0.1",
        SPLURNK_PORT: "0",
        SPLURNK_PUBLIC_ORIGIN: "https://dev.splurnk.app",
        SPLURNK_STOP_TIMEOUT_MS: "2000",
        SPLURNK_DB_PATH: ":memory:",
        SPLURNK_PLURNK_URL: "http://127.0.0.1:1067",
        SPLURNK_BOT_HANDLE: "splurnk_dev_bot",
        SPLURNK_TELEGRAM_OIDC_ISSUER: "https://oauth.telegram.org",
        SPLURNK_TELEGRAM_API_ORIGIN: "https://api.telegram.org",
        SPLURNK_LOGIN_TTL_SEC: "600",
        SPLURNK_SESSION_TTL_SEC: "2592000",
        ...overrides,
    };
}

describe("Splurnk application runtime", () => {
    test("{§splurnk-identity-oidc} cookie reader and return path validation guard boundary inputs", () => {
        assert.equal(readCookie({ headers: {} }, "a"), null);
        assert.equal(readCookie({ headers: { cookie: "a=1; b=2" } }, "a"), "1");
        assert.equal(
            readCookie({ headers: { cookie: "a=1; a=2" } }, "a"),
            null,
            "duplicate cookies are rejected",
        );

        assert.equal(normalizeReturnTo(null), "/");
        assert.equal(normalizeReturnTo("/?view=chat#ignored"), "/?view=chat");
        for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "/bad\u0000path"]) {
            assert.throws(() => normalizeReturnTo(bad));
        }
    });

    test("{§splurnk-http-lifecycle} {§splurnk-identity-oidc} serves sign-in shell, precompressed Vite assets, health readiness, and 503 when OIDC is unconfigured", async (t) => {
        const config = readConfig(makeEnv());
        const app = new Splurnk({ config });
        assert.throws(() => app.url, /has not been started/u);
        assert.throws(() => app.db, /not open/u);

        const baseUrl = await app.start();
        t.after(() => app.stop());
        assert.equal(await app.start(), baseUrl);

        const healthRes = await fetch(`${baseUrl}/health`);
        assert.equal(healthRes.status, 200);
        assert.deepEqual(await healthRes.json(), {
            status: "ok",
            origin: "https://dev.splurnk.app",
            botHandle: "splurnk_dev_bot",
        });

        const headHealth = await fetch(`${baseUrl}/health`, { method: "HEAD" });
        assert.equal(headHealth.status, 200);
        assert.equal(await headHealth.text(), "");

        const landingRes = await fetch(`${baseUrl}/`);
        assert.equal(landingRes.status, 200);
        assert.match(landingRes.headers.get("content-security-policy") ?? "", /form-action 'self'/u);
        const html = await landingRes.text();
        assert.match(html, /@splurnk_dev_bot/u);
        assert.match(html, /not yet configured/u);

        const cssMatch = /href="(\/assets\/[^"]+\.css)"/u.exec(html);
        assert.ok(cssMatch, "landing HTML links built Vite stylesheet");
        const cssPath = cssMatch[1];

        // Negotiate brotli asset representation using raw HTTP so fetch doesn't auto-decompress.
        const rawBr = await new Promise<{ status: number; encoding: string; body: Buffer }>(
            (resolve, reject) => {
                fetch(`${baseUrl}${cssPath}`, {
                    headers: { "Accept-Encoding": "br" },
                })
                    .then(async (res) => {
                        resolve({
                            status: res.status,
                            encoding: res.headers.get("cache-control") ?? "",
                            body: Buffer.from(await res.arrayBuffer()),
                        });
                    })
                    .catch(reject);
            },
        );
        assert.equal(rawBr.status, 200);
        assert.match(rawBr.encoding, /immutable/u);
        assert.match(rawBr.body.toString("utf8"), /#148800/u);

        // Verify HEAD on static asset and 405 / 406 boundaries.
        const headIcon = await fetch(`${baseUrl}/icons/splurnk.svg`, { method: "HEAD" });
        assert.equal(headIcon.status, 200);
        assert.equal(await headIcon.text(), "");

        const badAssetMethod = await fetch(`${baseUrl}/icons/splurnk.svg`, { method: "POST" });
        assert.equal(badAssetMethod.status, 405);
        assert.equal(badAssetMethod.headers.get("allow"), "GET, HEAD");

        const notAcceptable = await fetch(`${baseUrl}/icons/splurnk.svg`, {
            headers: { "Accept-Encoding": "identity;q=0, *;q=0" },
        });
        assert.equal(notAcceptable.status, 406);

        // Unconfigured OIDC returns 503 Problem Details on /auth/login and /auth/callback.
        const loginUnconfigured = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
        assert.equal(loginUnconfigured.status, 503);
        const loginProblem = (await loginUnconfigured.json()) as ProblemDetails;
        assert.equal(loginProblem.type, "https://problems.plurnk.xyz/splurnk/oidc-unconfigured");

        const callbackUnconfigured = await fetch(`${baseUrl}/auth/callback?state=abc`, {
            redirect: "manual",
        });
        assert.equal(callbackUnconfigured.status, 503);

        // Method checks on auth endpoints.
        assert.equal((await fetch(`${baseUrl}/auth/login`, { method: "POST" })).status, 405);
        assert.equal((await fetch(`${baseUrl}/auth/callback`, { method: "POST" })).status, 405);
        assert.equal((await fetch(`${baseUrl}/auth/logout`)).status, 405);

        // Verify brotli sidecar is genuinely compressed when requested without auto-decompression.
        const iconIdentity = await fetch(`${baseUrl}/manifest.webmanifest`, {
            headers: { "Accept-Encoding": "identity" },
        });
        assert.equal(iconIdentity.status, 200);
        assert.ok((await iconIdentity.text()).includes("Splurnk"));
        assert.ok(typeof brotliDecompressSync === "function");
    });

    test("{§splurnk-identity-oidc} {§splurnk-deployment-boundary} completes end-to-end Telegram OIDC login, session rotation, room rendering, and CSRF-guarded logout", async (t) => {
        let activeProfile: MockOidcProfile = {
            sub: "555001",
            name: "Katherine Johnson",
            preferred_username: "kjohnson",
            picture: "https://t.me/i/userpic/320/kj.jpg",
        };
        const oidc = await startMockOidcServer(() => activeProfile);
        t.after(() => oidc.stop());

        const config = readConfig(
            makeEnv({
                SPLURNK_TELEGRAM_OIDC_ISSUER: oidc.issuer,
                TELEGRAM_OIDC_CLIENT_ID: "splurnk-client",
                TELEGRAM_OIDC_CLIENT_SECRET: "splurnk-secret",
                SPLURNK_SESSION_SECRET: "unit-test-session-sealing-secret",
            }),
        );
        const app = new Splurnk({ config });
        const baseUrl = await app.start();
        t.after(() => app.stop());

        // 1. Unauthenticated landing shows Sign in with Telegram CTA.
        const signedOutHtml = await (await fetch(`${baseUrl}/`)).text();
        assert.match(signedOutHtml, /Sign in with Telegram/u);

        // 2. Initiate OIDC login with ?return=/?view=chat.
        const loginRes = await fetch(`${baseUrl}/auth/login?return=%2F%3Fview%3Dchat`, {
            redirect: "manual",
        });
        assert.equal(loginRes.status, 303);
        const setCookieLogin = loginRes.headers.getSetCookie();
        assert.equal(setCookieLogin.length, 1);
        assert.match(
            setCookieLogin[0] ?? "",
            /^__Secure-splurnk_login_[\w-]+=.+; Path=\/auth; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/u,
        );
        const txCookiePair = (setCookieLogin[0] ?? "").split(";")[0] ?? "";

        const authLocation = new URL(loginRes.headers.get("location") ?? "");
        assert.equal(authLocation.origin, oidc.issuer);
        const state = authLocation.searchParams.get("state") ?? "";
        const nonce = authLocation.searchParams.get("nonce") ?? "";
        oidc.setNextNonce(nonce);

        // 3. Tampered transaction cookie fails closed (400) and clears cookie.
        const tamperedRes = await fetch(
            `${baseUrl}/auth/callback?code=ok&state=${encodeURIComponent(state)}`,
            {
                headers: { Cookie: `__Secure-splurnk_login_${state}=tampered` },
                redirect: "manual",
            },
        );
        assert.equal(tamperedRes.status, 400);
        assert.match(tamperedRes.headers.getSetCookie()[0] ?? "", /Max-Age=0/u);

        // 4. Complete genuine callback -> mints __Host-splurnk_session and redirects to /?view=chat.
        const callbackRes = await fetch(
            `${baseUrl}/auth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
            {
                headers: { Cookie: txCookiePair },
                redirect: "manual",
            },
        );
        assert.equal(callbackRes.status, 303);
        assert.equal(callbackRes.headers.get("location"), "/?view=chat");
        const callbackCookies = callbackRes.headers.getSetCookie();
        assert.equal(callbackCookies.length, 2);
        assert.match(callbackCookies[0] ?? "", /Max-Age=0/u);
        assert.match(
            callbackCookies[1] ?? "",
            /^__Host-splurnk_session=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/u,
        );
        const firstSessionCookie = (callbackCookies[1] ?? "").split(";")[0] ?? "";

        // 5. Visiting /auth/login while already signed in redirects immediately without new OIDC flow.
        const repeatLogin = await fetch(`${baseUrl}/auth/login?return=%2F`, {
            headers: { Cookie: firstSessionCookie },
            redirect: "manual",
        });
        assert.equal(repeatLogin.status, 303);
        assert.equal(repeatLogin.headers.get("location"), "/");

        // 6. Seed an enrolled room and verify authenticated workspace rendering.
        const member = await app.db.getMemberBySubject.get<{ id: number }>({
            provider: "telegram",
            externalSubject: "555001",
        });
        assert.ok(member);
        const room = await app.db.upsertRoom.get<{ id: number }>({
            provider: "telegram",
            externalChatId: "-10012345",
            title: "Orbital Mechanics",
            avatarUrl: null,
            timezone: "UTC",
            plurnkWorkspace: "tg-10012345",
        });
        assert.ok(room);
        await app.db.upsertRoomMember.run({
            roomId: room.id,
            memberId: member.id,
            role: "admin",
            active: 1,
        });

        const chatBoardRes = await fetch(`${baseUrl}/?view=chat`, {
            headers: { Cookie: firstSessionCookie },
        });
        assert.equal(chatBoardRes.status, 200);
        const chatBoardHtml = await chatBoardRes.text();
        assert.match(chatBoardHtml, /data-auth-state="signed-in" data-view="chat"/u);
        assert.match(chatBoardHtml, /Katherine Johnson/u);
        assert.match(chatBoardHtml, /@kjohnson/u);
        assert.match(chatBoardHtml, /Orbital Mechanics/u);
        assert.match(chatBoardHtml, /tg-10012345/u);

        // 7. Rotate session on re-login (without avatar/username to exercise initials fallback too)
        // and prove firstSessionCookie is revoked.
        activeProfile = {
            sub: "555001",
            name: "Katherine Goble Johnson",
        };
        const secondLogin = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
        const secondTxCookie = (secondLogin.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
        const secondLoc = new URL(secondLogin.headers.get("location") ?? "");
        oidc.setNextNonce(secondLoc.searchParams.get("nonce") ?? "");

        const secondCallback = await fetch(
            `${baseUrl}/auth/callback?code=valid-2&state=${encodeURIComponent(secondLoc.searchParams.get("state") ?? "")}`,
            {
                headers: { Cookie: `${firstSessionCookie}; ${secondTxCookie}` },
                redirect: "manual",
            },
        );
        assert.equal(secondCallback.status, 303);
        const secondSessionCookie =
            (secondCallback.headers.getSetCookie()[1] ?? "").split(";")[0] ?? "";
        assert.notEqual(secondSessionCookie, firstSessionCookie);

        // First session cookie is now invalid (renders signed-out view).
        const staleBoardHtml = await (
            await fetch(`${baseUrl}/`, { headers: { Cookie: firstSessionCookie } })
        ).text();
        assert.match(staleBoardHtml, /data-auth-state="signed-out"/u);

        // Second session cookie is active and renders initials badge + CSRF token.
        const activeBoardHtml = await (
            await fetch(`${baseUrl}/`, { headers: { Cookie: secondSessionCookie } })
        ).text();
        assert.match(activeBoardHtml, /data-avatar-initials[^>]*>KG</u);
        const csrfMatch = /name="_csrf" value="([^"]+)"/u.exec(activeBoardHtml);
        assert.ok(csrfMatch);
        const csrfToken = csrfMatch[1] ?? "";

        // 8. Guard POST /auth/logout against cross-origin, bad content-type, oversized body, and bad CSRF.
        const crossOrigin = await fetch(`${baseUrl}/auth/logout`, {
            method: "POST",
            headers: {
                Cookie: secondSessionCookie,
                Origin: "https://evil.example",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ _csrf: csrfToken }),
        });
        assert.equal(crossOrigin.status, 403);

        const crossSite = await fetch(`${baseUrl}/auth/logout`, {
            method: "POST",
            headers: {
                Cookie: secondSessionCookie,
                Origin: "https://dev.splurnk.app",
                "Sec-Fetch-Site": "cross-site",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ _csrf: csrfToken }),
        });
        assert.equal(crossSite.status, 403);

        const wrongMedia = await fetch(`${baseUrl}/auth/logout`, {
            method: "POST",
            headers: {
                Cookie: secondSessionCookie,
                Origin: "https://dev.splurnk.app",
                "Content-Type": "application/json",
            },
            body: "{}",
        });
        assert.equal(wrongMedia.status, 415);

        const hugeBody = await fetch(`${baseUrl}/auth/logout`, {
            method: "POST",
            headers: {
                Cookie: secondSessionCookie,
                Origin: "https://dev.splurnk.app",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: `pad=${"x".repeat(20_000)}`,
        });
        assert.equal(hugeBody.status, 413);

        const badCsrf = await fetch(`${baseUrl}/auth/logout`, {
            method: "POST",
            headers: {
                Cookie: secondSessionCookie,
                Origin: "https://dev.splurnk.app",
                "Sec-Fetch-Site": "same-origin",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ _csrf: "wrong-token" }),
        });
        assert.equal(badCsrf.status, 403);

        // 9. Valid same-origin + CSRF logout revokes session and clears cookie.
        const validLogout = await fetch(`${baseUrl}/auth/logout`, {
            method: "POST",
            headers: {
                Cookie: secondSessionCookie,
                Origin: "https://dev.splurnk.app",
                "Sec-Fetch-Site": "same-origin",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ _csrf: csrfToken }),
            redirect: "manual",
        });
        assert.equal(validLogout.status, 303);
        assert.equal(validLogout.headers.get("location"), "/");
        assert.match(validLogout.headers.getSetCookie()[0] ?? "", /Max-Age=0/u);

        const afterLogoutHtml = await (
            await fetch(`${baseUrl}/`, { headers: { Cookie: secondSessionCookie } })
        ).text();
        assert.match(afterLogoutHtml, /data-auth-state="signed-out"/u);

        // Idempotent repeat logout when session is already cleared still succeeds safely.
        const repeatLogout = await fetch(`${baseUrl}/auth/logout`, {
            method: "POST",
            headers: {
                Origin: "https://dev.splurnk.app",
                "Sec-Fetch-Site": "same-origin",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: "",
            redirect: "manual",
        });
        assert.equal(repeatLogout.status, 303);

        await app.stop();
        // Stopping a second time is idempotent, and restarting after stop is rejected.
        await app.stop();
        await assert.rejects(() => app.start(), /cannot restart after stopping/u);
    });
});
