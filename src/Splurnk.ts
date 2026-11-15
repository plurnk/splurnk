// {§splurnk-http-lifecycle} {§splurnk-identity-oidc} {§splurnk-chat-seam} {§splurnk-deployment-boundary}
// Composed Splurnk application runtime: SqlRite persistence, Telegram OIDC sessions,
// modular ChatAdapter + RoomCoordinator tenancy, static assets, and bounded HTTP lifecycle.
import type { IncomingMessage, ServerResponse } from "node:http";
import type SqlRite from "@possumtech/sqlrite";
import type IdentityProvider from "./auth/IdentityProvider.ts";
import SessionManager, {
    normalizeReturnTo,
    OIDC_CALLBACK_PATH,
    PRIVATE_DOCUMENT_HEADERS,
} from "./auth/SessionManager.ts";
import TelegramIdentityProvider from "./auth/TelegramIdentityProvider.ts";
import type ChatAdapter from "./chat/ChatAdapter.ts";
import TelegramChatAdapter, { TELEGRAM_WEBHOOK_PATH } from "./chat/TelegramChatAdapter.ts";
import type { SplurnkConfig } from "./Config.ts";
import { openDatabase, type EnrolledRoom, type RoomRosterMember } from "./Database.ts";
import Documents, { type ViewMode } from "./Documents.ts";
import HttpError from "./HttpError.ts";
import RoomCoordinator, { type RoomMentionHandler } from "./rooms/RoomCoordinator.ts";
import SplurnkServer from "./Server.ts";
import { StaticAssets } from "./StaticAssets.ts";

const MAX_FORM_BYTES = 16_384;
const MAX_WEBHOOK_BYTES = 262_144;
const ROOM_JOIN_ROUTE = /^\/rooms\/join\/([^/]+)$/u;
const ROOM_ROTATE_ROUTE = /^\/rooms\/(\d+)\/rotate-join-link$/u;

export interface SplurnkDiagnosticEvent {
    readonly method: string;
    readonly pathname: string;
    readonly status: number;
    readonly problemSlug: string;
    readonly detail?: string;
    readonly cause?: string;
}

export type SplurnkDiagnosticHandler = (event: SplurnkDiagnosticEvent) => void;

export interface SplurnkOptions {
    readonly config: SplurnkConfig;
    readonly identityProvider?: IdentityProvider | null;
    readonly chatAdapter?: ChatAdapter | null;
    readonly onRoomMention?: RoomMentionHandler;
    readonly onDiagnostic?: SplurnkDiagnosticHandler;
    readonly staticAssets?: StaticAssets;
}

function sanitizeDiagnosticText(raw: string): string {
    return raw.replace(/\?[^\s"')]*/gu, "?[redacted]").slice(0, 240);
}

function formatCauseSummary(cause: unknown): string | undefined {
    if (cause instanceof Error) {
        return sanitizeDiagnosticText(`${cause.name}: ${cause.message}`);
    }
    return undefined;
}

function acceptsHtmlDocument(req: IncomingMessage): boolean {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
        return false;
    }
    const accept = req.headers.accept;
    return typeof accept === "string" && accept.includes("text/html");
}

function writeStatusDocument(
    res: ServerResponse,
    method: string,
    status: number,
    contentType: string,
    payload: string,
    headers: Readonly<Record<string, string>>,
): void {
    const body = Buffer.from(payload, "utf8");
    res.writeHead(status, {
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

function writeDocument(
    res: ServerResponse,
    method: string,
    contentType: string,
    payload: string,
    headers: Readonly<Record<string, string>>,
): void {
    writeStatusDocument(res, method, 200, contentType, payload, headers);
}

function redirectSeeOther(res: ServerResponse, location: string): void {
    res.writeHead(303, {
        ...PRIVATE_DOCUMENT_HEADERS,
        Location: location,
    });
    res.end();
}

async function readBoundedBody(req: IncomingMessage, maxBytes: number, label: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        totalBytes += buf.byteLength;
        if (totalBytes > maxBytes) {
            throw new HttpError(
                413,
                "payload-too-large",
                "Content Too Large",
                `${label} body exceeds ${maxBytes} bytes.`,
            );
        }
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
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
    const raw = await readBoundedBody(req, MAX_FORM_BYTES, "Form");
    return new URLSearchParams(raw.toString("utf8"));
}

async function readJsonPayload(req: IncomingMessage): Promise<unknown> {
    const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "application/json") {
        throw new HttpError(
            415,
            "unsupported-media-type",
            "Unsupported Media Type",
            "Webhook requests must use application/json.",
        );
    }
    const raw = await readBoundedBody(req, MAX_WEBHOOK_BYTES, "Webhook");
    try {
        return JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
        throw new HttpError(
            400,
            "invalid-webhook-payload",
            "Bad Request",
            "Webhook body is not valid JSON.",
        );
    }
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

function parsePositiveIntegerParam(raw: string | null, name: string): number | null {
    if (raw === null || raw.length === 0) {
        return null;
    }
    if (!/^\d+$/u.test(raw)) {
        throw new HttpError(400, `invalid-${name}`, "Bad Request", `Invalid ${name} parameter.`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new HttpError(400, `invalid-${name}`, "Bad Request", `Invalid ${name} parameter.`);
    }
    return parsed;
}

function decodePathSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        throw new HttpError(400, "invalid-path", "Bad Request", "Malformed URL path segment.");
    }
}

export default class Splurnk {
    readonly #config: SplurnkConfig;
    readonly #providedIdentityProvider: IdentityProvider | null | undefined;
    readonly #providedChatAdapter: ChatAdapter | null | undefined;
    readonly #onRoomMention: RoomMentionHandler | undefined;
    readonly #onDiagnostic: SplurnkDiagnosticHandler | undefined;
    readonly #providedAssets: StaticAssets | undefined;
    #db: SqlRite | null = null;
    #sessions: SessionManager | null = null;
    #rooms: RoomCoordinator | null = null;
    #telegramAdapter: TelegramChatAdapter | null = null;
    #assets: StaticAssets | null = null;
    #documents: Documents | null = null;
    #server: SplurnkServer | null = null;
    #stopping: Promise<void> | null = null;

    constructor(options: SplurnkOptions) {
        this.#config = options.config;
        this.#providedIdentityProvider = options.identityProvider;
        this.#providedChatAdapter = options.chatAdapter;
        this.#onRoomMention = options.onRoomMention;
        this.#onDiagnostic = options.onDiagnostic;
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

    get rooms(): RoomCoordinator {
        if (this.#rooms === null) {
            throw new Error("Splurnk room coordinator is not initialized.");
        }
        return this.#rooms;
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
            const { chatAdapter, telegramAdapter } = this.#resolveChatAdapter();

            if (this.#config.telegramSetWebhook && telegramAdapter !== null) {
                await telegramAdapter.registerWebhook(
                    `${this.#config.publicOrigin}${TELEGRAM_WEBHOOK_PATH}`,
                );
            }

            const sessions = new SessionManager({
                db,
                publicOrigin: this.#config.publicOrigin,
                loginTtlSec: this.#config.loginTtlSec,
                sessionTtlSec: this.#config.sessionTtlSec,
                sessionSecret: this.#config.secrets.sessionSecret,
                identityProvider,
            });
            const rooms = new RoomCoordinator({
                db,
                publicOrigin: this.#config.publicOrigin,
                botHandle: this.#config.botHandle,
                roomVerifyTtlSec: this.#config.roomVerifyTtlSec,
                chatAdapter,
                onRoomMention: this.#onRoomMention,
            });
            const server = new SplurnkServer(this.#config, (req, res) =>
                this.#route(req, res),
            );
            const boundUrl = await server.start();

            this.#db = db;
            this.#assets = assets;
            this.#documents = documents;
            this.#sessions = sessions;
            this.#rooms = rooms;
            this.#telegramAdapter = telegramAdapter;
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

    #resolveChatAdapter(): {
        readonly chatAdapter: ChatAdapter | null;
        readonly telegramAdapter: TelegramChatAdapter | null;
    } {
        if (this.#providedChatAdapter !== undefined) {
            return {
                chatAdapter: this.#providedChatAdapter,
                telegramAdapter:
                    this.#providedChatAdapter instanceof TelegramChatAdapter
                        ? this.#providedChatAdapter
                        : null,
            };
        }
        const { telegramBotToken } = this.#config.secrets;
        if (telegramBotToken === null) {
            return { chatAdapter: null, telegramAdapter: null };
        }
        const telegramAdapter = new TelegramChatAdapter({
            apiOrigin: this.#config.telegramApiOrigin,
            botToken: telegramBotToken,
            botHandle: this.#config.botHandle,
            publicOrigin: this.#config.publicOrigin,
        });
        return { chatAdapter: telegramAdapter, telegramAdapter };
    }

    async #shutdown(): Promise<void> {
        const server = this.#server;
        const db = this.#db;
        this.#server = null;
        this.#db = null;
        this.#sessions = null;
        this.#rooms = null;
        this.#telegramAdapter = null;
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
        const documents = this.#documents;
        const sessions = this.#sessions;
        const method = req.method ?? "GET";
        const parsedUrl = new URL(req.url ?? "/", this.#config.publicOrigin);
        const { pathname } = parsedUrl;

        try {
            return await this.#dispatchRoute(req, res, method, parsedUrl);
        } catch (error) {
            if (error instanceof HttpError) {
                if (error.status >= 500 || pathname.startsWith("/auth/")) {
                    const cause = formatCauseSummary(error.cause);
                    this.#onDiagnostic?.({
                        method,
                        pathname,
                        status: error.status,
                        problemSlug: error.problemSlug,
                        detail: error.message,
                        ...(cause !== undefined ? { cause } : {}),
                    });
                }
                if (
                    !res.headersSent &&
                    documents !== null &&
                    sessions !== null &&
                    pathname !== "/health" &&
                    acceptsHtmlDocument(req)
                ) {
                    const html = documents.renderError({
                        status: error.status,
                        title: error.title,
                        detail: error.message,
                        retryLoginHref:
                            pathname.startsWith("/auth/") && sessions.oidcConfigured
                                ? "/auth/login"
                                : null,
                    });
                    writeStatusDocument(
                        res,
                        method,
                        error.status,
                        "text/html; charset=utf-8",
                        html,
                        {
                            ...PRIVATE_DOCUMENT_HEADERS,
                            ...error.headers,
                        },
                    );
                    return true;
                }
                throw error;
            }

            const cause = formatCauseSummary(error);
            this.#onDiagnostic?.({
                method,
                pathname,
                status: 500,
                problemSlug: "request-failed",
                ...(cause !== undefined ? { cause } : {}),
            });
            throw error;
        }
    }

    async #dispatchRoute(
        req: IncomingMessage,
        res: ServerResponse,
        method: string,
        parsedUrl: URL,
    ): Promise<boolean> {
        const db = this.#db;
        const sessions = this.#sessions;
        const rooms = this.#rooms;
        const assets = this.#assets;
        const documents = this.#documents;
        if (
            db === null ||
            sessions === null ||
            rooms === null ||
            assets === null ||
            documents === null
        ) {
            throw new Error("Splurnk route invoked before startup settled.");
        }

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
                const returnTo = normalizeReturnTo(`${pathname}${parsedUrl.search}`);
                const html = documents.renderSignIn({
                    oidcConfigured: sessions.oidcConfigured,
                    returnTo,
                });
                writeDocument(res, method, "text/html; charset=utf-8", html, PRIVATE_DOCUMENT_HEADERS);
                return true;
            }

            const requestedRoomId = parsePositiveIntegerParam(
                parsedUrl.searchParams.get("room"),
                "room",
            );
            let selectedRoom: EnrolledRoom | null = null;
            let selectedRoomRoster: RoomRosterMember[] = [];
            if (requestedRoomId !== null) {
                selectedRoom = await rooms.getVerifiedMemberRoom(session.member, requestedRoomId);
                selectedRoomRoster = await rooms.listRoomRoster(session.member, selectedRoom.id);
            }

            const enrolledRooms = await rooms.listMemberRooms(session.member);
            const viewParam = parsedUrl.searchParams.get("view");
            const activeView: ViewMode = viewParam === "chat" ? "chat" : "tasks";

            const html = documents.renderWorkspace({
                config: this.#config,
                member: session.member,
                csrfToken: session.csrfToken,
                rooms: enrolledRooms,
                selectedRoom,
                selectedRoomRoster,
                activeView,
            });
            writeDocument(res, method, "text/html; charset=utf-8", html, PRIVATE_DOCUMENT_HEADERS);
            return true;
        }

        const joinMatch = ROOM_JOIN_ROUTE.exec(pathname);
        if (joinMatch !== null && joinMatch[1] !== undefined) {
            const joinCode = decodePathSegment(joinMatch[1]);
            if (method === "GET" || method === "HEAD") {
                const room = await rooms.getActiveRoomByJoinCode(joinCode);
                const session = await sessions.authenticate(req);
                const alreadyEnrolled =
                    session !== null
                        ? await rooms.isMemberEnrolled(session.member.id, room.id)
                        : false;
                const html = documents.renderRoomJoin({
                    room,
                    joinCode,
                    oidcConfigured: sessions.oidcConfigured,
                    chatConfigured: rooms.chatConfigured,
                    member: session?.member ?? null,
                    csrfToken: session?.csrfToken ?? null,
                    alreadyEnrolled,
                });
                writeDocument(res, method, "text/html; charset=utf-8", html, PRIVATE_DOCUMENT_HEADERS);
                return true;
            }
            if (method === "POST") {
                sessions.verifySameOriginForm(req);
                const form = await readUrlEncodedForm(req);
                const session = await sessions.authenticate(req);
                if (session === null) {
                    redirectSeeOther(
                        res,
                        `/auth/login?${new URLSearchParams({ return: pathname }).toString()}`,
                    );
                    return true;
                }
                sessions.verifyCsrfToken(session, form.get("_csrf"));
                const enrolledRoom = await rooms.joinRoomByCode(session.member, joinCode);
                redirectSeeOther(res, `/?room=${enrolledRoom.id}`);
                return true;
            }
            throw new HttpError(
                405,
                "method-not-allowed",
                "Method Not Allowed",
                `Method ${method} is not allowed on this resource.`,
                { headers: { Allow: "GET, HEAD, POST" } },
            );
        }

        const rotateMatch = ROOM_ROTATE_ROUTE.exec(pathname);
        if (rotateMatch !== null && rotateMatch[1] !== undefined) {
            requireMethod(method, "POST");
            const roomId = parsePositiveIntegerParam(rotateMatch[1], "room");
            if (roomId === null) {
                throw new HttpError(404, "not-found", "Not Found", "Room not found.");
            }
            sessions.verifySameOriginForm(req);
            const form = await readUrlEncodedForm(req);
            const session = await sessions.authenticate(req);
            if (session === null) {
                throw new HttpError(
                    401,
                    "authentication-required",
                    "Unauthorized",
                    "Sign in to manage room settings.",
                );
            }
            sessions.verifyCsrfToken(session, form.get("_csrf"));
            await rooms.rotateJoinCode(session.member, roomId);
            redirectSeeOther(res, `/?room=${roomId}`);
            return true;
        }

        if (pathname === TELEGRAM_WEBHOOK_PATH) {
            requireMethod(method, "POST");
            const telegramAdapter = this.#telegramAdapter;
            if (telegramAdapter === null) {
                throw new HttpError(
                    503,
                    "telegram-unconfigured",
                    "Service Unavailable",
                    "Telegram bot token is not configured on this instance.",
                );
            }
            const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
            telegramAdapter.verifyWebhookSecret(
                typeof secretHeader === "string" ? secretHeader : undefined,
            );
            const payload = await readJsonPayload(req);
            const events = telegramAdapter.parseUpdate(payload);
            await rooms.handleInboundEvents(events);
            writeDocument(res, "POST", "application/json; charset=utf-8", '{"ok":true}\n', {
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            });
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
