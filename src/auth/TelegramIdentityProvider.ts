// {§splurnk-identity-oidc} {§splurnk-deployment-boundary}
// Standard OpenID Connect client for Telegram (https://oauth.telegram.org).
// Uses Authorization Code + PKCE (S256), state, ClientSecretPost, and JWKS
// signature verification; extracts profile claims directly from the ID Token
// (Telegram exposes no UserInfo endpoint) and discards OAuth tokens immediately.
import * as oauth from "oauth4webapi";
import HttpError from "../HttpError.ts";
import type IdentityProvider from "./IdentityProvider.ts";
import type { AuthorizationBegin, IdentityProfile, OidcTransaction } from "./IdentityProvider.ts";

const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/u;
const NUMERIC_ID_PATTERN = /^[1-9]\d{0,19}$/u;
const TELEGRAM_OIDC_SCOPE = "openid profile telegram:bot_access";

export interface TelegramIdentityProviderOptions {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly fetchImpl?: typeof globalThis.fetch;
}

interface DiscoveredAuthority {
    readonly server: oauth.AuthorizationServer;
    readonly requestOptions: {
        readonly [oauth.allowInsecureRequests]: boolean;
        readonly [oauth.customFetch]?: typeof globalThis.fetch;
    };
}

function optionalTrimmedClaim(claims: Readonly<Record<string, unknown>>, key: string): string | null {
    const raw = claims[key];
    if (raw === undefined || raw === null) {
        return null;
    }
    if (typeof raw !== "string") {
        throw new HttpError(
            502,
            "oidc-claims-invalid",
            "Bad Gateway",
            `Telegram ID token returned a non-string ${key} claim.`,
        );
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function canonicalTelegramSubject(claims: Readonly<Record<string, unknown>>): string {
    const sub = optionalTrimmedClaim(claims, "sub");
    if (sub === null || sub.length > 128) {
        throw new HttpError(
            502,
            "oidc-claims-invalid",
            "Bad Gateway",
            "Telegram ID token is missing a valid sub claim.",
        );
    }

    const rawId = claims.id;
    if (rawId === undefined || rawId === null) {
        return sub;
    }
    if (typeof rawId === "number") {
        if (!Number.isSafeInteger(rawId) || rawId <= 0) {
            throw new HttpError(
                502,
                "oidc-claims-invalid",
                "Bad Gateway",
                "Telegram ID token returned an invalid numeric id claim.",
            );
        }
        return String(rawId);
    }
    if (typeof rawId === "string") {
        const trimmedId = rawId.trim();
        if (!NUMERIC_ID_PATTERN.test(trimmedId)) {
            throw new HttpError(
                502,
                "oidc-claims-invalid",
                "Bad Gateway",
                "Telegram ID token returned an invalid string id claim.",
            );
        }
        return trimmedId;
    }
    throw new HttpError(
        502,
        "oidc-claims-invalid",
        "Bad Gateway",
        "Telegram ID token returned an unsupported id claim type.",
    );
}

async function normalizeTokenEndpointResponse(rawResponse: Response): Promise<Response> {
    let payload: unknown;
    try {
        payload = await rawResponse.json();
    } catch (cause) {
        throw new HttpError(
            502,
            "oidc-upstream-failed",
            "Bad Gateway",
            "Telegram token endpoint returned malformed JSON.",
            { cause },
        );
    }

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new HttpError(
            502,
            "oidc-upstream-failed",
            "Bad Gateway",
            "Telegram token endpoint returned an invalid response object.",
        );
    }

    const record = payload as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.length > 0) {
        if (record.error === "invalid_grant") {
            throw new HttpError(
                400,
                "oidc-grant-invalid",
                "Bad Request",
                "Sign-in was not completed. Start sign-in again.",
            );
        }
        const desc =
            typeof record.error_description === "string" && record.error_description.length > 0
                ? ` (${record.error_description.slice(0, 120)})`
                : "";
        throw new HttpError(
            502,
            "oidc-upstream-failed",
            "Bad Gateway",
            "Telegram did not complete authentication.",
            { cause: new Error(`OAuth token error (${rawResponse.status}): ${record.error}${desc}`) },
        );
    }

    if (rawResponse.status !== 200 || typeof record.id_token !== "string" || record.id_token.length === 0) {
        const keys = Object.keys(record).slice(0, 8).join(",");
        throw new HttpError(
            502,
            "oidc-upstream-failed",
            "Bad Gateway",
            "Telegram did not complete authentication.",
            {
                cause: new Error(
                    `OAuth token response (${rawResponse.status}) missing id_token [keys=${keys}]`,
                ),
            },
        );
    }

    // Telegram OIDC issues an ID Token without a UserInfo/resource API; synthesize unused
    // OAuth bearer fields when omitted so oauth4webapi validates the ID Token JWS + claims.
    const normalizedBody: Record<string, unknown> = {
        ...record,
        access_token:
            typeof record.access_token === "string" && record.access_token.length > 0
                ? record.access_token
                : "oidc-id-token-only",
        token_type:
            typeof record.token_type === "string" && record.token_type.length > 0
                ? record.token_type
                : "Bearer",
    };

    return Response.json(normalizedBody, { status: 200 });
}

export function profileFromIdToken(claims: Readonly<Record<string, unknown>>): IdentityProfile {
    const subject = canonicalTelegramSubject(claims);

    const rawUsername = optionalTrimmedClaim(claims, "preferred_username");
    let username: string | null = null;
    if (rawUsername !== null) {
        const normalized = rawUsername.startsWith("@") ? rawUsername.slice(1) : rawUsername;
        if (!USERNAME_PATTERN.test(normalized)) {
            throw new HttpError(
                502,
                "oidc-claims-invalid",
                "Bad Gateway",
                "Telegram ID token returned an invalid preferred_username claim.",
            );
        }
        username = normalized;
    }

    const fullName = optionalTrimmedClaim(claims, "name");
    const givenName = optionalTrimmedClaim(claims, "given_name");
    const familyName = optionalTrimmedClaim(claims, "family_name");
    const joinedGivenFamily = [givenName, familyName].filter((part): part is string => part !== null).join(" ");
    const displayName =
        fullName ??
        (joinedGivenFamily.length > 0 ? joinedGivenFamily : null) ??
        username;
    if (displayName === null) {
        throw new HttpError(
            502,
            "oidc-claims-invalid",
            "Bad Gateway",
            "Telegram ID token is missing a display name.",
        );
    }

    const rawPicture = optionalTrimmedClaim(claims, "picture");
    let avatarUrl: string | null = null;
    if (rawPicture !== null) {
        let parsed: URL;
        try {
            parsed = new URL(rawPicture);
        } catch (cause) {
            throw new HttpError(
                502,
                "oidc-claims-invalid",
                "Bad Gateway",
                "Telegram ID token returned an invalid picture URL.",
                { cause },
            );
        }
        if (parsed.protocol !== "https:") {
            throw new HttpError(
                502,
                "oidc-claims-invalid",
                "Bad Gateway",
                "Telegram ID token picture URL must use https:.",
            );
        }
        avatarUrl = parsed.href;
    }

    return {
        subject,
        username,
        displayName: displayName.slice(0, 128),
        avatarUrl,
    };
}

export default class TelegramIdentityProvider implements IdentityProvider {
    readonly #issuer: URL;
    readonly #client: oauth.Client;
    readonly #authenticate: oauth.ClientAuth;
    readonly #redirectUri: string;
    readonly #fetchImpl: typeof globalThis.fetch | undefined;
    #authorityPromise: Promise<DiscoveredAuthority> | null = null;

    constructor(options: TelegramIdentityProviderOptions) {
        this.#issuer = new URL(options.issuer);
        this.#client = { client_id: options.clientId };
        this.#authenticate = oauth.ClientSecretPost(options.clientSecret);
        this.#redirectUri = options.redirectUri;
        this.#fetchImpl = options.fetchImpl;
    }

    async begin(returnTo: string, expiresAt: number): Promise<AuthorizationBegin> {
        const { server } = await this.#discover();
        if (!server.authorization_endpoint) {
            throw new HttpError(
                502,
                "oidc-discovery-incomplete",
                "Bad Gateway",
                "Telegram OIDC discovery metadata omitted authorization_endpoint.",
            );
        }

        const state = oauth.generateRandomState();
        const codeVerifier = oauth.generateRandomCodeVerifier();
        const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

        const authorizationUrl = new URL(server.authorization_endpoint);
        authorizationUrl.search = new URLSearchParams({
            client_id: this.#client.client_id,
            redirect_uri: this.#redirectUri,
            response_type: "code",
            scope: TELEGRAM_OIDC_SCOPE,
            code_challenge_method: "S256",
            code_challenge: codeChallenge,
            state,
        }).toString();

        return {
            authorizationUrl,
            transaction: {
                state,
                codeVerifier,
                redirectUri: this.#redirectUri,
                returnTo,
                expiresAt,
            },
        };
    }

    async finish(callbackUrl: URL, transaction: OidcTransaction): Promise<IdentityProfile> {
        const { server, requestOptions } = await this.#discover();

        let callbackParams: URLSearchParams;
        try {
            callbackParams = oauth.validateAuthResponse(server, this.#client, callbackUrl, transaction.state);
        } catch (cause) {
            throw new HttpError(
                400,
                "oidc-callback-invalid",
                "Bad Request",
                "Sign-in was not completed. Start sign-in again.",
                { cause },
            );
        }

        let rawTokenResponse: Response;
        try {
            rawTokenResponse = await oauth.authorizationCodeGrantRequest(
                server,
                this.#client,
                this.#authenticate,
                callbackParams,
                transaction.redirectUri,
                transaction.codeVerifier,
                requestOptions,
            );
        } catch (cause) {
            throw new HttpError(
                502,
                "oidc-upstream-failed",
                "Bad Gateway",
                "Could not reach the Telegram token endpoint.",
                { cause },
            );
        }

        const tokenResponse = await normalizeTokenEndpointResponse(rawTokenResponse);

        let tokenResult: oauth.TokenEndpointResponse;
        try {
            tokenResult = await oauth.processAuthorizationCodeResponse(server, this.#client, tokenResponse, {
                requireIdToken: true,
            });
        } catch (cause) {
            throw new HttpError(
                502,
                "oidc-upstream-failed",
                "Bad Gateway",
                "Telegram did not complete authentication.",
                { cause },
            );
        }

        try {
            await oauth.validateApplicationLevelSignature(server, tokenResponse, requestOptions);
        } catch (cause) {
            throw new HttpError(
                502,
                "oidc-signature-invalid",
                "Bad Gateway",
                "Telegram ID token signature verification failed.",
                { cause },
            );
        }

        const claims = oauth.getValidatedIdTokenClaims(tokenResult);
        if (!claims) {
            throw new HttpError(
                502,
                "oidc-claims-invalid",
                "Bad Gateway",
                "Telegram token response omitted validated ID token claims.",
            );
        }

        // Extract identity claims and allow tokenResult (access_token, id_token, refresh_token)
        // to fall out of scope immediately without persistence.
        return profileFromIdToken(claims);
    }

    async #discover(): Promise<DiscoveredAuthority> {
        if (this.#authorityPromise !== null) {
            return await this.#authorityPromise;
        }
        this.#authorityPromise = this.#fetchMetadata().catch((error: unknown) => {
            this.#authorityPromise = null;
            throw error;
        });
        return await this.#authorityPromise;
    }

    async #fetchMetadata(): Promise<DiscoveredAuthority> {
        const requestOptions = {
            [oauth.allowInsecureRequests]: this.#issuer.protocol === "http:",
            ...(this.#fetchImpl === undefined ? {} : { [oauth.customFetch]: this.#fetchImpl }),
        };
        try {
            const response = await oauth.discoveryRequest(this.#issuer, {
                ...requestOptions,
                algorithm: "oidc",
            });
            const server = await oauth.processDiscoveryResponse(this.#issuer, response);
            return { server, requestOptions };
        } catch (cause) {
            throw new HttpError(
                502,
                "oidc-discovery-failed",
                "Bad Gateway",
                "Could not discover Telegram OIDC configuration.",
                { cause },
            );
        }
    }
}
