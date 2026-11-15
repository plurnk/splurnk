import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, test } from "node:test";
import * as oauth from "oauth4webapi";
import HttpError from "../HttpError.ts";
import TelegramIdentityProvider, { profileFromIdToken } from "./TelegramIdentityProvider.ts";

const RSA_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_JWK = {
    ...(RSA_KEYS.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    alg: "RS256",
    use: "sig",
    kid: "oidc-1",
};

function signJwt(payload: Record<string, unknown>, privateKey = RSA_KEYS.privateKey): string {
    const header = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT", kid: "oidc-1" }),
        "utf8",
    ).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${body}`);
    const signature = signer.sign(privateKey).toString("base64url");
    return `${header}.${body}.${signature}`;
}

describe("TelegramIdentityProvider", () => {
    test("{§splurnk-identity-oidc} profileFromIdToken resolves canonical Telegram user id, optional username, and rejects invalid fields", () => {
        const withNumericId = profileFromIdToken({
            sub: "1234123412341234123",
            id: 424242,
            preferred_username: "@wikitopian",
            name: "Hyzen Operator",
            picture: "https://t.me/i/userpic/320/hyzen.jpg",
        });
        assert.deepEqual(withNumericId, {
            subject: "424242",
            username: "wikitopian",
            displayName: "Hyzen Operator",
            avatarUrl: "https://t.me/i/userpic/320/hyzen.jpg",
        });

        const withStringId = profileFromIdToken({
            sub: "opaque-sub-9001",
            id: "9001",
            given_name: "Ada",
            family_name: "Lovelace",
        });
        assert.deepEqual(withStringId, {
            subject: "9001",
            username: null,
            displayName: "Ada Lovelace",
            avatarUrl: null,
        });

        const usernameOnly = profileFromIdToken({
            sub: "9002",
            preferred_username: "ada_bot",
        });
        assert.equal(usernameOnly.subject, "9002");
        assert.equal(usernameOnly.displayName, "ada_bot");

        for (const badClaims of [
            {},
            { sub: 12345, name: "Numeric Sub" },
            { sub: "1", id: 0, name: "Zero Id" },
            { sub: "1", id: -5, name: "Negative Id" },
            { sub: "1", id: 1.5, name: "Float Id" },
            { sub: "1", id: "not-digits", name: "Bad String Id" },
            { sub: "1", id: true, name: "Boolean Id" },
            { sub: "1", preferred_username: "not valid handle!", name: "Bad Handle" },
            { sub: "1" },
            { sub: "1", name: "Bad Pic", picture: "not-a-url" },
            { sub: "1", name: "Insecure Pic", picture: "http://example.com/a.png" },
        ]) {
            assert.throws(
                () => profileFromIdToken(badClaims as Record<string, unknown>),
                (err: unknown) => err instanceof HttpError && err.status === 502,
            );
        }
    });

    test("{§splurnk-identity-oidc} executes Authorization Code + PKCE S256 + JWKS verification without calling UserInfo and maps HTTP 200/400 invalid_grant", async () => {
        const issuer = "https://oauth.telegram.example";
        const redirectUri = "https://splurnk.example/auth/callback";
        let capturedChallenge = "";
        let redeemedCount = 0;
        let userInfoCalled = false;

        const mockFetch: typeof globalThis.fetch = async (input, init) => {
            const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
            if (url.pathname === "/.well-known/openid-configuration") {
                return Response.json({
                    issuer,
                    authorization_endpoint: `${issuer}/auth`,
                    token_endpoint: `${issuer}/token`,
                    jwks_uri: `${issuer}/.well-known/jwks.json`,
                    id_token_signing_alg_values_supported: ["RS256"],
                    code_challenge_methods_supported: ["S256"],
                });
            }
            if (url.pathname === "/.well-known/jwks.json") {
                return Response.json({
                    keys: [PUBLIC_JWK],
                });
            }
            if (url.pathname === "/userinfo") {
                userInfoCalled = true;
                return new Response("Not Found", { status: 404 });
            }
            if (url.pathname === "/token") {
                const authHeader = new Headers(init?.headers).get("authorization") ?? "";
                assert.match(authHeader, /^Basic /u);
                const decodedCreds = Buffer.from(authHeader.slice("Basic ".length), "base64")
                    .toString("utf8")
                    .split(":")
                    .map((part) => decodeURIComponent(part));
                assert.deepEqual(decodedCreds, ["client-123", "secret-xyz"]);
                const body = new URLSearchParams(String(init?.body ?? ""));
                assert.equal(body.get("grant_type"), "authorization_code");
                assert.equal(body.get("redirect_uri"), redirectUri);
                const verifier = body.get("code_verifier") ?? "";
                const recomputed = await oauth.calculatePKCECodeChallenge(verifier);
                assert.equal(recomputed, capturedChallenge);

                const callIndex = redeemedCount++;
                if (callIndex === 1) {
                    // Live oauth.telegram.org/token returns HTTP 200 on invalid_grant.
                    return Response.json({ error: "invalid_grant" }, { status: 200 });
                }
                if (callIndex > 1) {
                    return Response.json({ error: "invalid_grant" }, { status: 400 });
                }

                const nowSec = Math.floor(Date.now() / 1000);
                const idToken = signJwt({
                    iss: issuer,
                    sub: "opaque-subject-777888999",
                    id: 777888999,
                    aud: "client-123",
                    iat: nowSec,
                    exp: nowSec + 300,
                    name: "Grace Hopper",
                    preferred_username: "ghopper",
                    picture: "https://t.me/i/userpic/320/grace.jpg",
                });
                return Response.json({
                    access_token: "discard-me-access-token",
                    token_type: "Bearer",
                    expires_in: 300,
                    id_token: idToken,
                });
            }
            return new Response("Unexpected route", { status: 500 });
        };

        const provider = new TelegramIdentityProvider({
            issuer,
            clientId: "client-123",
            clientSecret: "secret-xyz",
            redirectUri,
            fetchImpl: mockFetch,
        });

        const began = await provider.begin("/?view=chat", Date.now() + 60_000);
        assert.equal(began.authorizationUrl.origin, issuer);
        assert.equal(began.authorizationUrl.pathname, "/auth");
        assert.equal(
            began.authorizationUrl.searchParams.get("scope"),
            "openid profile telegram:bot_access",
        );
        assert.deepEqual([...began.authorizationUrl.searchParams.keys()].toSorted(), [
            "client_id",
            "code_challenge",
            "code_challenge_method",
            "redirect_uri",
            "response_type",
            "scope",
            "state",
        ]);
        assert.equal(began.authorizationUrl.searchParams.get("code_challenge_method"), "S256");
        capturedChallenge = began.authorizationUrl.searchParams.get("code_challenge") ?? "";

        const callbackUrl = new URL(
            `${redirectUri}?code=one-time-code&state=${encodeURIComponent(began.transaction.state)}`,
        );
        const profile = await provider.finish(callbackUrl, began.transaction);
        assert.equal(userInfoCalled, false);
        assert.deepEqual(profile, {
            subject: "777888999",
            username: "ghopper",
            displayName: "Grace Hopper",
            avatarUrl: "https://t.me/i/userpic/320/grace.jpg",
        });

        // Replaying the redeemed code maps both HTTP 200 and HTTP 400 invalid_grant cleanly to 400.
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await assert.rejects(
                () => provider.finish(callbackUrl, began.transaction),
                (err: unknown) =>
                    err instanceof HttpError &&
                    err.status === 400 &&
                    err.problemSlug === "oidc-grant-invalid",
            );
        }

        // Mismatched callback state maps cleanly to 400.
        await assert.rejects(
            () =>
                provider.finish(
                    new URL(`${redirectUri}?code=x&state=wrong-state`),
                    began.transaction,
                ),
            (err: unknown) =>
                err instanceof HttpError &&
                err.status === 400 &&
                err.problemSlug === "oidc-callback-invalid",
        );
    });

    test("{§splurnk-identity-oidc} rejects forged ID token signatures and recovers after transient discovery failure", async () => {
        const issuer = "https://oauth.telegram.example";
        const redirectUri = "https://splurnk.example/auth/callback";
        const rogueKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
        let failDiscovery = true;

        const provider = new TelegramIdentityProvider({
            issuer,
            clientId: "client-123",
            clientSecret: "secret-xyz",
            redirectUri,
            fetchImpl: async (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/.well-known/openid-configuration") {
                    if (failDiscovery) {
                        return new Response("Upstream Down", { status: 503 });
                    }
                    return Response.json({
                        issuer,
                        authorization_endpoint: `${issuer}/auth`,
                        token_endpoint: `${issuer}/token`,
                        jwks_uri: `${issuer}/.well-known/jwks.json`,
                    });
                }
                if (url.pathname === "/.well-known/jwks.json") {
                    return Response.json({ keys: [PUBLIC_JWK] });
                }
                const nowSec = Math.floor(Date.now() / 1000);
                const forgedIdToken = signJwt(
                    {
                        iss: issuer,
                        sub: "attacker",
                        aud: "client-123",
                        iat: nowSec,
                        exp: nowSec + 300,
                        name: "Forged",
                    },
                    rogueKeys.privateKey,
                );
                return Response.json({
                    access_token: "tok",
                    token_type: "Bearer",
                    id_token: forgedIdToken,
                });
            },
        });

        await assert.rejects(
            () => provider.begin("/", Date.now() + 60_000),
            (err: unknown) =>
                err instanceof HttpError &&
                err.status === 502 &&
                err.problemSlug === "oidc-discovery-failed",
        );

        failDiscovery = false;
        const began = await provider.begin("/", Date.now() + 60_000);

        await assert.rejects(
            () =>
                provider.finish(
                    new URL(`${redirectUri}?code=abc&state=${began.transaction.state}`),
                    began.transaction,
                ),
            (err: unknown) =>
                err instanceof HttpError &&
                err.status === 502 &&
                err.problemSlug === "oidc-signature-invalid",
        );
    });
});
