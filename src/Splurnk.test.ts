import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import {
    deriveTelegramWebhookSecret,
    normalizeReturnTo,
    readConfig,
    readCookie,
    Splurnk,
    TelegramChatAdapter,
    type ProblemDetails,
    type SplurnkDiagnosticEvent,
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
    id?: number;
    name: string;
    preferred_username?: string;
    picture?: string;
}

async function startMockOidcServer(getProfile: () => MockOidcProfile): Promise<{
    issuer: string;
    stop(): Promise<void>;
}> {
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
                // Live oauth.telegram.org/token answers HTTP 200 on invalid_grant.
                res.writeHead(200, { "Content-Type": "application/json" });
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
        SPLURNK_TELEGRAM_SET_WEBHOOK: "0",
        SPLURNK_ROOM_VERIFY_TTL_SEC: "300",
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

    test("{§splurnk-web-shell} {§splurnk-http-lifecycle} {§splurnk-identity-oidc} serves spartan sign-in shell, plurnk-web icons and manifest, precompressed Vite assets, health readiness, and 503 when OIDC is unconfigured", async (t) => {
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
        assert.match(html, /<a href="\/" title="Home"><img src="\/icons\/splurnk\.svg" width="32" height="32" alt="Splurnk"><\/a>/u);
        assert.match(html, /Sign-in unavailable\./u);
        assert.doesNotMatch(html, /data-signout/u);

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

        // Verify icons, maskable SVG, Noto Apache-2.0 notices, and manifest contract.
        const svgText = await (await fetch(`${baseUrl}/icons/splurnk.svg`)).text();
        assert.match(svgText, /Splurnk hamster with glasses and a green bow/u);
        const maskableText = await (await fetch(`${baseUrl}/icons/splurnk-maskable.svg`)).text();
        assert.match(maskableText, /translate\(19\.2 19\.2\) scale\(0\.7\)/u);
        assert.equal((await fetch(`${baseUrl}/icons/NOTO-NOTICE.txt`)).status, 200);
        assert.equal((await fetch(`${baseUrl}/icons/APACHE-2.0.txt`)).status, 200);

        const iconIdentity = await fetch(`${baseUrl}/manifest.webmanifest`, {
            headers: { "Accept-Encoding": "identity" },
        });
        assert.equal(iconIdentity.status, 200);
        const manifestJson = (await iconIdentity.json()) as {
            id: string;
            icons: Array<{ src: string; sizes: string; purpose: string }>;
        };
        assert.equal(manifestJson.id, "/");
        assert.deepEqual(
            manifestJson.icons.map((entry) => `${entry.src}:${entry.purpose}:${entry.sizes}`),
            ["/icons/splurnk.svg:any:any", "/icons/splurnk-maskable.svg:maskable:any"],
        );
        assert.ok(typeof brotliDecompressSync === "function");
    });

    test("{§splurnk-identity-oidc} {§splurnk-deployment-boundary} completes end-to-end Telegram OIDC login, session rotation, browser callback recovery, room rendering, and CSRF-guarded logout", async (t) => {
        let activeProfile: MockOidcProfile = {
            sub: "opaque-kj-subject",
            id: 555001,
            name: "Katherine Johnson",
            preferred_username: "kjohnson",
            picture: "https://t.me/i/userpic/320/kj.jpg",
        };
        const oidc = await startMockOidcServer(() => activeProfile);
        t.after(() => oidc.stop());

        const diagnostics: SplurnkDiagnosticEvent[] = [];
        const config = readConfig(
            makeEnv({
                SPLURNK_TELEGRAM_OIDC_ISSUER: oidc.issuer,
                TELEGRAM_OIDC_CLIENT_ID: "splurnk-client",
                TELEGRAM_OIDC_CLIENT_SECRET: "splurnk-secret",
                SPLURNK_SESSION_SECRET: "unit-test-session-sealing-secret",
            }),
        );
        const app = new Splurnk({
            config,
            onDiagnostic(event) {
                diagnostics.push(event);
            },
        });
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
        assert.equal(
            authLocation.searchParams.get("scope"),
            "openid profile telegram:bot_access",
        );
        const state = authLocation.searchParams.get("state") ?? "";

        // 3. Tampered transaction cookie fails closed (400), clears cookie, and renders HTML recovery for browsers.
        const tamperedRes = await fetch(
            `${baseUrl}/auth/callback?code=secret-code-123&state=${encodeURIComponent(state)}`,
            {
                headers: { Cookie: `__Secure-splurnk_login_${state}=tampered` },
                redirect: "manual",
            },
        );
        assert.equal(tamperedRes.status, 400);
        assert.match(tamperedRes.headers.get("content-type") ?? "", /application\/problem\+json/u);
        assert.match(tamperedRes.headers.getSetCookie()[0] ?? "", /Max-Age=0/u);

        const browserCallbackError = await fetch(
            `${baseUrl}/auth/callback?code=secret-code-456&state=${encodeURIComponent(state)}`,
            {
                headers: { Accept: "text/html,application/xhtml+xml" },
                redirect: "manual",
            },
        );
        assert.equal(browserCallbackError.status, 400);
        assert.match(browserCallbackError.headers.get("content-type") ?? "", /text\/html/u);
        const browserErrorHtml = await browserCallbackError.text();
        assert.match(browserErrorHtml, /400 Bad Request/u);
        assert.match(browserErrorHtml, /<a href="\/auth\/login" role="button">Sign in with Telegram<\/a>/u);

        const browserCallbackHead = await fetch(
            `${baseUrl}/auth/callback?code=secret-code-789&state=${encodeURIComponent(state)}`,
            {
                method: "HEAD",
                headers: { Accept: "text/html" },
                redirect: "manual",
            },
        );
        assert.equal(browserCallbackHead.status, 405);

        // Verify HTTP 200 {"error":"invalid_grant"} from Telegram maps to 400 oidc-grant-invalid + sanitized diagnostics.
        const badGrantLogin = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
        const badGrantCookie = (badGrantLogin.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
        const badGrantState =
            new URL(badGrantLogin.headers.get("location") ?? "").searchParams.get("state") ?? "";
        const badGrantCallback = await fetch(
            `${baseUrl}/auth/callback?code=bad-code&state=${encodeURIComponent(badGrantState)}`,
            {
                headers: { Accept: "text/html", Cookie: badGrantCookie },
                redirect: "manual",
            },
        );
        assert.equal(badGrantCallback.status, 400);
        assert.match(await badGrantCallback.text(), /Sign in with Telegram/u);

        // Diagnostics omit query strings, authorization codes, and state tokens.
        assert.ok(diagnostics.some((entry) => entry.problemSlug === "oidc-grant-invalid"));
        for (const entry of diagnostics) {
            const serialized = JSON.stringify(entry);
            assert.doesNotMatch(serialized, /secret-code|bad-code/u);
            assert.equal(entry.pathname, "/auth/callback");
        }

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

        // Re-visiting /auth/callback without a transaction cookie while already signed in redirects cleanly to /.
        const replaySignedInCallback = await fetch(
            `${baseUrl}/auth/callback?code=bad-code&state=${encodeURIComponent(state)}`,
            {
                headers: { Cookie: firstSessionCookie },
                redirect: "manual",
            },
        );
        assert.equal(replaySignedInCallback.status, 303);
        assert.equal(replaySignedInCallback.headers.get("location"), "/");

        // Browser GET on non-auth 404 route renders spartan HTML error card with Home link.
        const browserMissingRoom = await fetch(`${baseUrl}/?room=99999`, {
            headers: { Accept: "text/html", Cookie: firstSessionCookie },
        });
        assert.equal(browserMissingRoom.status, 404);
        assert.match(await browserMissingRoom.text(), /<a href="\/">Home<\/a>/u);
        const browserMissingRoomHead = await fetch(`${baseUrl}/?room=99999`, {
            method: "HEAD",
            headers: { Accept: "text/html", Cookie: firstSessionCookie },
        });
        assert.equal(browserMissingRoomHead.status, 404);
        assert.equal(await browserMissingRoomHead.text(), "");

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
            joinCode: "orbital-join-code-0123456789abcdef",
        });
        assert.ok(room);
        await app.db.upsertRoomMember.run({
            roomId: room.id,
            memberId: member.id,
            role: "admin",
            active: 1,
            verifiedAt: Date.now(),
        });

        const chatBoardRes = await fetch(`${baseUrl}/?view=chat`, {
            headers: { Cookie: firstSessionCookie },
        });
        assert.equal(chatBoardRes.status, 200);
        const chatBoardHtml = await chatBoardRes.text();
        assert.match(chatBoardHtml, /data-auth-state="signed-in" data-view="chat"/u);
        assert.match(chatBoardHtml, /Katherine Johnson \(@kjohnson\)/u);
        assert.match(chatBoardHtml, /Orbital Mechanics/u);
        assert.match(chatBoardHtml, /No messages\./u);

        // 7. Rotate session on re-login (without avatar/username to exercise initials fallback too)
        // and prove firstSessionCookie is revoked.
        activeProfile = {
            sub: "opaque-kj-subject",
            id: 555001,
            name: "Katherine Goble Johnson",
        };
        const secondLogin = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
        const secondTxCookie = (secondLogin.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
        const secondLoc = new URL(secondLogin.headers.get("location") ?? "");

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

    test("{§splurnk-chat-seam} {§splurnk-identity-oidc} enforces HTTP multi-room isolation, verified join links, admin link rotation, and Telegram webhook filtering", async (t) => {
        let activeProfile: MockOidcProfile = {
            sub: "7001",
            name: "Alice Founder",
            preferred_username: "alice",
        };
        const oidc = await startMockOidcServer(() => activeProfile);
        t.after(() => oidc.stop());

        const botToken = "888777:TEST_BOT_SECRET";
        const publicOrigin = "https://dev.splurnk.app";
        const webhookSecret = deriveTelegramWebhookSecret(botToken, publicOrigin);
        const setWebhookCalls: Array<Record<string, unknown>> = [];
        const sentMessages: Array<Record<string, unknown>> = [];
        const liveGroupRoles = new Map<string, string>([
            ["-10077:7001", "administrator"],
            ["-10077:7002", "member"],
            ["-10088:8001", "creator"],
        ]);

        const telegramAdapter = new TelegramChatAdapter({
            apiOrigin: "https://api.telegram.org",
            botToken,
            botHandle: "splurnk_dev_bot",
            publicOrigin,
            fetchImpl: async (input, init) => {
                const method = String(input).split("/").at(-1) ?? "";
                const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
                if (method === "setWebhook") {
                    setWebhookCalls.push(body);
                    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
                }
                if (method === "getChatAdministrators") {
                    const chatId = String(body.chat_id);
                    const admins =
                        chatId === "-10077"
                            ? [{ status: "administrator", user: { id: 7001, is_bot: false, first_name: "Alice" } }]
                            : [{ status: "creator", user: { id: 8001, is_bot: false, first_name: "Bob" } }];
                    return new Response(JSON.stringify({ ok: true, result: admins }), { status: 200 });
                }
                if (method === "getChatMember") {
                    const status = liveGroupRoles.get(`${String(body.chat_id)}:${String(body.user_id)}`);
                    if (!status) {
                        return new Response(
                            JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: user not found" }),
                            { status: 400 },
                        );
                    }
                    return new Response(JSON.stringify({ ok: true, result: { status } }), { status: 200 });
                }
                if (method === "sendMessage") {
                    sentMessages.push(body);
                    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
                }
                return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
            },
        });

        const mentionedPrompts: string[] = [];
        const config = readConfig(
            makeEnv({
                SPLURNK_TELEGRAM_OIDC_ISSUER: oidc.issuer,
                SPLURNK_TELEGRAM_SET_WEBHOOK: "1",
                SPLURNK_ROOM_VERIFY_TTL_SEC: "1",
                TELEGRAM_OIDC_CLIENT_ID: "splurnk-client",
                TELEGRAM_OIDC_CLIENT_SECRET: "splurnk-secret",
                TELEGRAM_BOT_TOKEN: botToken,
                SPLURNK_SESSION_SECRET: "multi-room-test-secret",
            }),
        );
        const app = new Splurnk({
            config,
            chatAdapter: telegramAdapter,
            onRoomMention: async (ctx) => {
                mentionedPrompts.push(`${ctx.room.title}:${ctx.promptText}`);
                return `Ack ${ctx.promptText}`;
            },
        });
        assert.throws(() => app.rooms, /not initialized/u);
        const baseUrl = await app.start();
        t.after(() => app.stop());

        assert.equal(setWebhookCalls.length, 1);
        assert.equal(setWebhookCalls[0]?.url, "https://dev.splurnk.app/webhooks/telegram");

        // 1. Webhook rejects wrong method, forged secret, wrong media type, and malformed JSON.
        assert.equal((await fetch(`${baseUrl}/webhooks/telegram`)).status, 405);
        assert.equal(
            (
                await fetch(`${baseUrl}/webhooks/telegram`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: "{}",
                })
            ).status,
            401,
        );
        assert.equal(
            (
                await fetch(`${baseUrl}/webhooks/telegram`, {
                    method: "POST",
                    headers: {
                        "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
                        "Content-Type": "text/plain",
                    },
                    body: "{}",
                })
            ).status,
            415,
        );
        assert.equal(
            (
                await fetch(`${baseUrl}/webhooks/telegram`, {
                    method: "POST",
                    headers: {
                        "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
                        "Content-Type": "application/json",
                    },
                    body: "{not-json",
                })
            ).status,
            400,
        );

        // 2. Enroll two separate Telegram groups via webhook + verify non-mention chatter is ignored.
        const postWebhook = async (payload: Record<string, unknown>): Promise<Response> =>
            await fetch(`${baseUrl}/webhooks/telegram`, {
                method: "POST",
                headers: {
                    "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
            });

        assert.equal(
            (
                await postWebhook({
                    update_id: 100,
                    my_chat_member: {
                        chat: { id: -10077, type: "supergroup", title: "Room Seven" },
                        from: { id: 7001, is_bot: false, first_name: "Alice" },
                        new_chat_member: { status: "member", user: { id: 1, is_bot: true } },
                    },
                })
            ).status,
            200,
        );
        assert.equal(
            (
                await postWebhook({
                    update_id: 101,
                    my_chat_member: {
                        chat: { id: -10088, type: "supergroup", title: "Room Eight" },
                        from: { id: 8001, is_bot: false, first_name: "Bob" },
                        new_chat_member: { status: "member", user: { id: 1, is_bot: true } },
                    },
                })
            ).status,
            200,
        );
        assert.equal(sentMessages.length, 2);

        // Unmentioned message does not trigger mention handler or send any message.
        await postWebhook({
            update_id: 102,
            message: {
                message_id: 50,
                from: { id: 7001, is_bot: false, first_name: "Alice" },
                chat: { id: -10077, type: "supergroup", title: "Room Seven" },
                text: "Casual chatter without bot tag",
            },
        });
        assert.equal(mentionedPrompts.length, 0);
        assert.equal(sentMessages.length, 2);

        // Explicit @splurnk_dev_bot mention dispatches and replies!
        await postWebhook({
            update_id: 103,
            message: {
                message_id: 51,
                from: { id: 7001, is_bot: false, first_name: "Alice" },
                chat: { id: -10077, type: "supergroup", title: "Room Seven" },
                text: "@splurnk_dev_bot plan groceries",
                entities: [{ type: "mention", offset: 0, length: 16 }],
            },
        });
        assert.deepEqual(mentionedPrompts, ["Room Seven:plan groceries"]);
        assert.equal(sentMessages.at(-1)?.text, "Ack plan groceries");

        // Extract join URLs emitted in welcome messages.
        const joinSevenMatch = /\/rooms\/join\/([\w-]+)/u.exec(String(sentMessages[0]?.text ?? ""));
        const joinEightMatch = /\/rooms\/join\/([\w-]+)/u.exec(String(sentMessages[1]?.text ?? ""));
        assert.ok(joinSevenMatch && joinEightMatch);
        const joinCodeSeven = joinSevenMatch[1]!;
        const joinCodeEight = joinEightMatch[1]!;

        // Helper to sign in a user via OIDC and return their session cookie + CSRF token.
        const signInAs = async (profile: MockOidcProfile): Promise<{ cookie: string; csrf: string }> => {
            activeProfile = profile;
            const begin = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
            const txPair = (begin.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
            const loc = new URL(begin.headers.get("location") ?? "");
            const finish = await fetch(
                `${baseUrl}/auth/callback?code=ok&state=${encodeURIComponent(loc.searchParams.get("state") ?? "")}`,
                { headers: { Cookie: txPair }, redirect: "manual" },
            );
            const cookie = (finish.headers.getSetCookie()[1] ?? "").split(";")[0] ?? "";
            const homeHtml = await (await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } })).text();
            const csrf = /name="_csrf" value="([^"]+)"/u.exec(homeHtml)?.[1] ?? "";
            return { cookie, csrf };
        };

        const aliceAuth = await signInAs({
            sub: "opaque-7001",
            id: 7001,
            name: "Alice Founder",
            preferred_username: "alice",
        });

        // 3. Alice sees Room Seven, NOT Room Eight; probing ?room=<RoomEight.id> or malformed ?room=abc fails closed!
        const roomEightRow = await app.db.getRoomByJoinCode.get<{ id: number }>({ joinCode: joinCodeEight });
        const roomSevenRow = await app.db.getRoomByJoinCode.get<{ id: number }>({ joinCode: joinCodeSeven });
        assert.ok(roomSevenRow && roomEightRow);

        assert.equal(
            (await fetch(`${baseUrl}/?room=abc`, { headers: { Cookie: aliceAuth.cookie } })).status,
            400,
        );
        assert.equal(
            (await fetch(`${baseUrl}/?room=${roomEightRow.id}`, { headers: { Cookie: aliceAuth.cookie } })).status,
            404,
        );
        const aliceRoomSevenHtml = await (
            await fetch(`${baseUrl}/?room=${roomSevenRow.id}`, { headers: { Cookie: aliceAuth.cookie } })
        ).text();
        assert.match(aliceRoomSevenHtml, /Room Seven/u);
        assert.doesNotMatch(aliceRoomSevenHtml, /Room Eight/u);
        assert.match(aliceRoomSevenHtml, /Rotate join link/u);

        // Alice attempting to join Room Eight via its join link is rejected (403 not-room-member).
        const aliceJoinEight = await fetch(`${baseUrl}/rooms/join/${joinCodeEight}`, {
            method: "POST",
            headers: {
                Cookie: aliceAuth.cookie,
                Origin: publicOrigin,
                "Sec-Fetch-Site": "same-origin",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ _csrf: aliceAuth.csrf }),
            redirect: "manual",
        });
        assert.equal(aliceJoinEight.status, 403);

        // 4. Signed-out visitor hitting GET /rooms/join/:code sees OIDC prompt with ?return=...
        const signedOutJoinRes = await fetch(`${baseUrl}/rooms/join/${joinCodeSeven}`);
        assert.equal(signedOutJoinRes.status, 200);
        const signedOutJoinHtml = await signedOutJoinRes.text();
        assert.match(signedOutJoinHtml, /<h1>Room Seven<\/h1>/u);
        assert.match(signedOutJoinHtml, /Sign in with Telegram/u);

        // 5. Carol (member 7002 of Room Seven) signs in, views join card, joins Room Seven, cannot rotate link (403).
        const carolAuth = await signInAs({
            sub: "opaque-7002",
            id: 7002,
            name: "Carol Peer",
            preferred_username: "carol",
        });
        const carolJoinPage = await (
            await fetch(`${baseUrl}/rooms/join/${joinCodeSeven}`, { headers: { Cookie: carolAuth.cookie } })
        ).text();
        assert.match(carolJoinPage, /<h1>Room Seven<\/h1>/u);
        assert.match(carolJoinPage, /<button type="submit">Join<\/button>/u);

        const carolJoinPost = await fetch(`${baseUrl}/rooms/join/${joinCodeSeven}`, {
            method: "POST",
            headers: {
                Cookie: carolAuth.cookie,
                Origin: publicOrigin,
                "Sec-Fetch-Site": "same-origin",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ _csrf: carolAuth.csrf }),
            redirect: "manual",
        });
        assert.equal(carolJoinPost.status, 303);
        assert.equal(carolJoinPost.headers.get("location"), `/?room=${roomSevenRow.id}`);

        const carolRotateAttempt = await fetch(`${baseUrl}/rooms/${roomSevenRow.id}/rotate-join-link`, {
            method: "POST",
            headers: {
                Cookie: carolAuth.cookie,
                Origin: publicOrigin,
                "Sec-Fetch-Site": "same-origin",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ _csrf: carolAuth.csrf }),
            redirect: "manual",
        });
        assert.equal(carolRotateAttempt.status, 403);

        // 6. Alice (admin of Room Seven) rotates the join link -> old joinCode returns 404!
        const aliceRotate = await fetch(`${baseUrl}/rooms/${roomSevenRow.id}/rotate-join-link`, {
            method: "POST",
            headers: {
                Cookie: aliceAuth.cookie,
                Origin: publicOrigin,
                "Sec-Fetch-Site": "same-origin",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ _csrf: aliceAuth.csrf }),
            redirect: "manual",
        });
        assert.equal(aliceRotate.status, 303);
        assert.equal(
            (await fetch(`${baseUrl}/rooms/join/${joinCodeSeven}`)).status,
            404,
        );
    });
});
