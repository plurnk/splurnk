// {§splurnk-http-lifecycle} {§splurnk-identity-oidc} {§splurnk-deployment-boundary}
// Composed Splurnk application runtime: SqlRite persistence, Telegram OIDC sessions,
// Vite/OTM static assets and semantic HTML views, and bounded HTTP lifecycle.
import type { IncomingMessage, ServerResponse } from "node:http";
import type SqlRite from "@possumtech/sqlrite";
import type IdentityProvider from "./auth/IdentityProvider.ts";
import SessionManager, {
    OIDC_CALLBACK_PATH,
    PRIVATE_DOCUMENT_HEADERS,
} from "./auth/SessionManager.ts";
import TelegramIdentityProvider from "./auth/TelegramIdentityProvider.ts";
import type { SplurnkConfig } from "./Config.ts";
import { openDatabase, type EnrolledRoom } from "./Database.ts";
import Documents, { type ViewMode } from "./Documents.ts";
import HttpError from "./HttpError.ts";
import SplurnkServer from "./Server.ts";
import { StaticAssets } from "./StaticAssets.ts";

const MAX_FORM_BYTES = 16_384;

interface EnrolledRoomRow {
    readonly id: number;
    readonly provider: string;
    readonly external_chat_id: string;
    readonly title: string;
    readonly avatar_url: string | null;
    readonly timezone: string;
    readonly plurnk_workspace: string;
    readonly role: "admin" | "member";
}

export interface SplurnkOptions {
    readonly config: SplurnkConfig;
    readonly identityProvider?: IdentityProvider | null;
    readonly staticAssets?: StaticAssets;
}

function writeDocument(
    res: ServerResponse,
    method: string,
    contentType: string,
    payload: string,
    headers: Readonly<Record<string, string>>,
): void {
    const body = Buffer.from(payload, "utf8");
    res.writeHead(200, {
        ...headers,
        "Content-Length": String(body.byteLength),
        "Content-Type": contentType,
    });
    if (method === "HEAD") {
        res.end();
        return;
    }
    res.end(body);
}

async function readUrlEncodedForm(req: IncomingMessage): Promise<URLSearchParams> {
    const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "" && contentType !== "application/x-www-form-urlencoded") {
        throw new HttpError(
            415,
            "unsupported-media-type",
            "Unsupported Media Type",
            "Form submissions must use application/x-www-form-urlencoded.",
        );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        totalBytes += buf.byteLength;
        if (totalBytes > MAX_FORM_BYTES) {
            throw new HttpError(
                413,
                "payload-too-large",
                "Content Too Large",
                `Form body exceeds ${MAX_FORM_BYTES} bytes.`,
            );
        }
        chunks.push(buf);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function requireGetOrHead(method: string): void {
    if (method !== "GET" && method !== "HEAD") {
        throw new HttpError(
            405,
            "method-not-allowed",
            "Method Not Allowed",
            `Method ${method} is not allowed on this resource.`,
            { headers: { Allow: "GET, HEAD" } },
        );
    }
}

function requireMethod(method: string, allowed: string): void {
    if (method !== allowed) {
        throw new HttpError(
            405,
            "method-not-allowed",
            "Method Not Allowed",
            `Method ${method} is not allowed on this resource.`,
            { headers: { Allow: allowed } },
        );
    }
}

export default class Splurnk {
    readonly #config: SplurnkConfig;
    readonly #providedIdentityProvider: IdentityProvider | null | undefined;
    readonly #providedAssets: StaticAssets | undefined;
    #db: SqlRite | null = null;
    #sessions: SessionManager | null = null;
    #assets: StaticAssets | null = null;
    #documents: Documents | null = null;
    #server: SplurnkServer | null = null;
    #stopping: Promise<void> | null = null;

    constructor(options: SplurnkOptions) {
        this.#config = options.config;
        this.#providedIdentityProvider = options.identityProvider;
        this.#providedAssets = options.staticAssets;
    }

    get url(): string {
        if (this.#server === null) {
            throw new Error("Splurnk has not been started.");
        }
        return this.#server.url;
    }

    get db(): SqlRite {
        if (this.#db === null) {
            throw new Error("Splurnk database is not open.");
        }
        return this.#db;
    }

    async start(): Promise<string> {
        if (this.#stopping !== null) {
            throw new Error("Splurnk cannot restart after stopping.");
        }
        if (this.#server !== null) {
            return this.#server.url;
        }

        const db = await openDatabase(this.#config.dbPath);
        try {
            const assets = this.#providedAssets ?? (await StaticAssets.loadFromDist());
            const documents = new Documents(assets.indexHtml);
            const identityProvider = this.#resolveIdentityProvider();
            const sessions = new SessionManager({
                db,
                publicOrigin: this.#config.publicOrigin,
                loginTtlSec: this.#config.loginTtlSec,
                sessionTtlSec: this.#config.sessionTtlSec,
                sessionSecret: this.#config.secrets.sessionSecret,
                identityProvider,
            });
            const server = new SplurnkServer(this.#config, (req, res) =>
                this.#route(req, res),
            );
            const boundUrl = await server.start();

            this.#db = db;
            this.#assets = assets;
            this.#documents = documents;
            this.#sessions = sessions;
            this.#server = server;
            return boundUrl;
        } catch (error) {
            await db.close();
            throw error;
        }
    }

    async stop(): Promise<void> {
        if (this.#stopping !== null) {
            return await this.#stopping;
        }
        this.#stopping = this.#shutdown();
        return await this.#stopping;
    }

    #resolveIdentityProvider(): IdentityProvider | null {
        if (this.#providedIdentityProvider !== undefined) {
            return this.#providedIdentityProvider;
        }
        const { telegramOidcClientId, telegramOidcClientSecret } = this.#config.secrets;
        if (telegramOidcClientId === null || telegramOidcClientSecret === null) {
            return null;
        }
        return new TelegramIdentityProvider({
            issuer: this.#config.telegramOidcIssuer,
            clientId: telegramOidcClientId,
            clientSecret: telegramOidcClientSecret,
            redirectUri: `${this.#config.publicOrigin}${OIDC_CALLBACK_PATH}`,
        });
    }

    async #shutdown(): Promise<void> {
        const server = this.#server;
        const db = this.#db;
        this.#server = null;
        this.#db = null;
        this.#sessions = null;
        this.#assets = null;
        this.#documents = null;

        try {
            if (server !== null) {
                await server.stop();
            }
        } finally {
            if (db !== null) {
                await db.close();
            }
        }
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const db = this.#db;
        const sessions = this.#sessions;
        const assets = this.#assets;
        const documents = this.#documents;
        if (db === null || sessions === null || assets === null || documents === null) {
            throw new Error("Splurnk route invoked before startup settled.");
        }

        const method = req.method ?? "GET";
        const parsedUrl = new URL(req.url ?? "/", this.#config.publicOrigin);
        const { pathname } = parsedUrl;

        if (pathname === "/health") {
            requireGetOrHead(method);
            await db.healthPing.get();
            writeDocument(
                res,
                method,
                "application/json; charset=utf-8",
                `${JSON.stringify({
                    status: "ok",
                    origin: this.#config.publicOrigin,
                    botHandle: this.#config.botHandle,
                })}\n`,
                {
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                },
            );
            return true;
        }

        if (pathname === "/") {
            requireGetOrHead(method);
            const session = await sessions.authenticate(req);
            if (session === null) {
                const html = documents.renderSignIn({
                    config: this.#config,
                    oidcConfigured: sessions.oidcConfigured,
                    returnTo: "/",
                });
                writeDocument(res, method, "text/html; charset=utf-8", html, PRIVATE_DOCUMENT_HEADERS);
                return true;
            }

            const roomRows = await db.listMemberRooms.all<EnrolledRoomRow>({
                memberId: session.member.id,
            });
            const rooms: EnrolledRoom[] = roomRows.map((row) => ({
                id: row.id,
                provider: row.provider,
                externalChatId: row.external_chat_id,
                title: row.title,
                avatarUrl: row.avatar_url,
                timezone: row.timezone,
                plurnkWorkspace: row.plurnk_workspace,
                role: row.role,
            }));
            const viewParam = parsedUrl.searchParams.get("view");
            const activeView: ViewMode = viewParam === "chat" ? "chat" : "tasks";

            const html = documents.renderWorkspace({
                config: this.#config,
                member: session.member,
                csrfToken: session.csrfToken,
                rooms,
                activeView,
            });
            writeDocument(res, method, "text/html; charset=utf-8", html, PRIVATE_DOCUMENT_HEADERS);
            return true;
        }

        if (pathname === "/auth/login") {
            requireMethod(method, "GET");
            await sessions.login(req, res);
            return true;
        }

        if (pathname === OIDC_CALLBACK_PATH) {
            requireMethod(method, "GET");
            await sessions.callback(req, res);
            return true;
        }

        if (pathname === "/auth/logout") {
            requireMethod(method, "POST");
            const form = await readUrlEncodedForm(req);
            await sessions.logout(req, res, form);
            return true;
        }

        return assets.serve(req, res, pathname);
    }
}
