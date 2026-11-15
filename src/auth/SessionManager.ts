// {§splurnk-identity-oidc} {§splurnk-http-lifecycle}
// Cookie-backed OIDC login transactions and SqlRite-persisted member sessions.
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    hkdfSync,
    randomBytes,
    timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type SqlRite from "@possumtech/sqlrite";
import type { MemberRecord } from "../Database.ts";
import HttpError from "../HttpError.ts";
import type IdentityProvider from "./IdentityProvider.ts";
import type { OidcTransaction } from "./IdentityProvider.ts";

const SESSION_COOKIE = "splurnk_session";
const TRANSACTION_PREFIX = "splurnk_login_";
const HOST_PREFIX = "__Host-";
const SECURE_PREFIX = "__Secure-";
const STATE_PATTERN = /^[\w-]+$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export const OIDC_CALLBACK_PATH = "/auth/callback";

export const PRIVATE_DOCUMENT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
    "Cache-Control": "no-store",
    "Content-Security-Policy":
        "default-src 'self'; img-src 'self' https: data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
});

export interface AuthenticatedSession {
    readonly sidHash: string;
    readonly csrfToken: string;
    readonly expiresAt: number;
    readonly member: MemberRecord;
}

interface AuthenticatedSessionRow {
    readonly sid_hash: string;
    readonly csrf_token: string;
    readonly expires_at: number;
    readonly member_id: number;
    readonly provider: string;
    readonly external_subject: string;
    readonly username: string | null;
    readonly display_name: string;
    readonly avatar_url: string | null;
    readonly is_agent: number;
}

interface UpsertMemberRow {
    readonly id: number;
    readonly provider: string;
    readonly external_subject: string;
    readonly username: string | null;
    readonly display_name: string;
    readonly avatar_url: string | null;
    readonly is_agent: number;
}

export interface SessionManagerOptions {
    readonly db: SqlRite;
    readonly publicOrigin: string;
    readonly loginTtlSec: number;
    readonly sessionTtlSec: number;
    readonly sessionSecret: string | null;
    readonly identityProvider: IdentityProvider | null;
}

export function readCookie(req: Pick<IncomingMessage, "headers">, name: string): string | null {
    const raw = req.headers.cookie;
    if (typeof raw !== "string" || raw.length === 0) {
        return null;
    }
    const matches = raw
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${name}=`));
    if (matches.length !== 1) {
        return null;
    }
    const value = matches[0].slice(name.length + 1);
    return value.length > 0 ? value : null;
}

export function normalizeReturnTo(raw: string | null): string {
    if (raw === null || raw.length === 0) {
        return "/";
    }
    if (
        !raw.startsWith("/") ||
        raw.startsWith("//") ||
        raw.startsWith("/\\") ||
        CONTROL_CHARS.test(raw)
    ) {
        throw new HttpError(400, "invalid-return-path", "Bad Request", "Invalid return path.");
    }
    const parsed = new URL(raw, "http://localhost");
    if (parsed.origin !== "http://localhost") {
        throw new HttpError(400, "invalid-return-path", "Bad Request", "Invalid return path.");
    }
    return `${parsed.pathname}${parsed.search}`;
}

function hashSessionToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

function deriveSealingKey(sessionSecret: string | null): Buffer {
    if (sessionSecret === null) {
        return randomBytes(32);
    }
    return Buffer.from(hkdfSync("sha256", sessionSecret, "splurnk-oidc-transaction-v1", "", 32));
}

function redirectSeeOther(res: ServerResponse, location: string): void {
    res.writeHead(303, {
        ...PRIVATE_DOCUMENT_HEADERS,
        Location: location,
    });
    res.end();
}

export default class SessionManager {
    readonly #db: SqlRite;
    readonly #publicOrigin: string;
    readonly #secure: boolean;
    readonly #loginTtlSec: number;
    readonly #sessionTtlSec: number;
    readonly #sealingKey: Buffer;
    readonly #identityProvider: IdentityProvider | null;

    constructor(options: SessionManagerOptions) {
        this.#db = options.db;
        this.#publicOrigin = options.publicOrigin;
        this.#secure = options.publicOrigin.startsWith("https:");
        this.#loginTtlSec = options.loginTtlSec;
        this.#sessionTtlSec = options.sessionTtlSec;
        this.#sealingKey = deriveSealingKey(options.sessionSecret);
        this.#identityProvider = options.identityProvider;
    }

    get oidcConfigured(): boolean {
        return this.#identityProvider !== null;
    }

    async authenticate(req: Pick<IncomingMessage, "headers">): Promise<AuthenticatedSession | null> {
        const token = readCookie(req, this.#sessionCookieName());
        if (token === null) {
            return null;
        }
        const sidHash = hashSessionToken(token);
        const now = Date.now();
        const row = await this.#db.getAuthenticatedSession.get<AuthenticatedSessionRow>({
            sidHash,
            now,
        });
        if (!row) {
            return null;
        }
        await this.#db.touchSession.run({ sidHash, now });
        return {
            sidHash: row.sid_hash,
            csrfToken: row.csrf_token,
            expiresAt: row.expires_at,
            member: {
                id: row.member_id,
                provider: row.provider,
                externalSubject: row.external_subject,
                username: row.username,
                displayName: row.display_name,
                avatarUrl: row.avatar_url,
                isAgent: row.is_agent === 1,
            },
        };
    }

    verifySameOriginForm(req: Pick<IncomingMessage, "headers">): void {
        const fetchSite = req.headers["sec-fetch-site"];
        if (fetchSite !== undefined && fetchSite !== "same-origin") {
            throw new HttpError(403, "forbidden-origin", "Forbidden", "Same-origin form submission is required.");
        }
        if (req.headers.origin !== this.#publicOrigin) {
            throw new HttpError(403, "forbidden-origin", "Forbidden", "Same-origin form submission is required.");
        }
    }

    verifyCsrfToken(session: AuthenticatedSession, suppliedToken: string | null): void {
        const candidate = suppliedToken ?? "";
        const expectedBytes = Buffer.from(session.csrfToken, "utf8");
        const candidateBytes = Buffer.from(candidate, "utf8");
        if (
            expectedBytes.byteLength !== candidateBytes.byteLength ||
            !timingSafeEqual(expectedBytes, candidateBytes)
        ) {
            throw new HttpError(
                403,
                "invalid-csrf-token",
                "Forbidden",
                "The form token is invalid or expired. Reload the page and try again.",
            );
        }
    }

    async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const requestUrl = new URL(req.url ?? "/", this.#publicOrigin);
        const returnTo = normalizeReturnTo(requestUrl.searchParams.get("return"));

        const existing = await this.authenticate(req);
        if (existing !== null) {
            redirectSeeOther(res, returnTo);
            return;
        }

        if (this.#identityProvider === null) {
            throw new HttpError(
                503,
                "oidc-unconfigured",
                "Service Unavailable",
                "Telegram OpenID Connect credentials are not configured on this instance.",
            );
        }

        const expiresAt = Date.now() + this.#loginTtlSec * 1000;
        const { authorizationUrl, transaction } = await this.#identityProvider.begin(returnTo, expiresAt);
        const cookieName = this.#transactionCookieName(transaction.state);
        const sealed = this.#sealTransaction(cookieName, transaction);

        res.setHeader(
            "Set-Cookie",
            this.#formatCookie(cookieName, sealed, "/auth", this.#loginTtlSec),
        );
        redirectSeeOther(res, authorizationUrl.href);
    }

    async callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (this.#identityProvider === null) {
            throw new HttpError(
                503,
                "oidc-unconfigured",
                "Service Unavailable",
                "Telegram OpenID Connect credentials are not configured on this instance.",
            );
        }

        const callbackUrl = new URL(req.url ?? "/", this.#publicOrigin);
        const state = callbackUrl.searchParams.get("state") ?? "";
        const invalidTransaction = new HttpError(
            400,
            "oidc-transaction-invalid",
            "Bad Request",
            "This browser holds no active sign-in transaction for this callback. Start sign-in again.",
        );
        if (!STATE_PATTERN.test(state)) {
            throw invalidTransaction;
        }

        const txCookieName = this.#transactionCookieName(state);
        const sealed = readCookie(req, txCookieName);
        if (sealed === null) {
            const existing = await this.authenticate(req);
            if (existing !== null) {
                redirectSeeOther(res, "/");
                return;
            }
        }
        const clearedTxCookie = this.#formatCookie(txCookieName, "", "/auth", 0);
        res.setHeader("Set-Cookie", clearedTxCookie);

        const transaction = sealed === null ? null : this.#openTransaction(txCookieName, sealed);
        if (transaction === null || transaction.state !== state || transaction.expiresAt <= Date.now()) {
            throw invalidTransaction;
        }

        const profile = await this.#identityProvider.finish(callbackUrl, transaction);
        const memberRow = await this.#db.upsertMember.get<UpsertMemberRow>({
            provider: "telegram",
            externalSubject: profile.subject,
            username: profile.username,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            isAgent: 0,
        });
        if (!memberRow) {
            throw new Error("upsertMember failed to return the persisted member row.");
        }

        const previousToken = readCookie(req, this.#sessionCookieName());
        if (previousToken !== null) {
            await this.#db.destroySession.run({ sidHash: hashSessionToken(previousToken) });
        }

        const now = Date.now();
        await this.#db.clearExpiredSessions.run({ now });

        const rawSessionToken = randomBytes(32).toString("base64url");
        const sidHash = hashSessionToken(rawSessionToken);
        const csrfToken = randomBytes(32).toString("base64url");
        const expiresAt = now + this.#sessionTtlSec * 1000;

        await this.#db.createSession.run({
            sidHash,
            memberId: memberRow.id,
            csrfToken,
            expiresAt,
        });

        res.setHeader("Set-Cookie", [
            clearedTxCookie,
            this.#formatCookie(this.#sessionCookieName(), rawSessionToken, "/", this.#sessionTtlSec),
        ]);
        redirectSeeOther(res, normalizeReturnTo(transaction.returnTo));
    }

    async logout(req: IncomingMessage, res: ServerResponse, form: URLSearchParams): Promise<void> {
        this.verifySameOriginForm(req);
        const activeSession = await this.authenticate(req);
        if (activeSession !== null) {
            this.verifyCsrfToken(activeSession, form.get("_csrf"));
            await this.#db.destroySession.run({ sidHash: activeSession.sidHash });
        }
        res.setHeader("Set-Cookie", this.#formatCookie(this.#sessionCookieName(), "", "/", 0));
        redirectSeeOther(res, "/");
    }

    #sessionCookieName(): string {
        return `${this.#secure ? HOST_PREFIX : ""}${SESSION_COOKIE}`;
    }

    #transactionCookieName(state: string): string {
        return `${this.#secure ? SECURE_PREFIX : ""}${TRANSACTION_PREFIX}${state}`;
    }

    #formatCookie(name: string, value: string, path: string, ttlSec: number): string {
        const maxAge = Math.max(0, Math.ceil(ttlSec));
        return (
            `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
            (this.#secure ? "; Secure" : "")
        );
    }

    #sealTransaction(cookieName: string, transaction: OidcTransaction): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.#sealingKey, iv, {
            authTagLength: 16,
        }).setAAD(Buffer.from(cookieName, "utf8"));
        const ciphertext = Buffer.concat([
            cipher.update(JSON.stringify(transaction), "utf8"),
            cipher.final(),
        ]);
        return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url");
    }

    #openTransaction(cookieName: string, sealed: string): OidcTransaction | null {
        const bytes = Buffer.from(sealed, "base64url");
        if (bytes.byteLength < 28) {
            return null;
        }
        try {
            const decipher = createDecipheriv("aes-256-gcm", this.#sealingKey, bytes.subarray(0, 12), {
                authTagLength: 16,
            }).setAAD(Buffer.from(cookieName, "utf8"));
            decipher.setAuthTag(bytes.subarray(-16));
            const plaintext = Buffer.concat([
                decipher.update(bytes.subarray(12, -16)),
                decipher.final(),
            ]).toString("utf8");
            const parsed = JSON.parse(plaintext) as Partial<OidcTransaction>;
            if (
                typeof parsed.state !== "string" ||
                typeof parsed.codeVerifier !== "string" ||
                typeof parsed.redirectUri !== "string" ||
                typeof parsed.returnTo !== "string" ||
                typeof parsed.expiresAt !== "number"
            ) {
                return null;
            }
            return parsed as OidcTransaction;
        } catch {
            return null;
        }
    }
}
