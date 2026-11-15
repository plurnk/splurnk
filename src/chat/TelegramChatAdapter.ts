// {§splurnk-chat-seam} {§splurnk-deployment-boundary} {§splurnk-configuration}
// Telegram Bot HTTP API implementation of ChatAdapter with constant-time webhook verification,
// strict @botHandle mention filtering (6.B), and outbound-only direct notifications.
import { hkdfSync, timingSafeEqual } from "node:crypto";
import HttpError from "../HttpError.ts";
import type ChatAdapter from "./ChatAdapter.ts";
import type {
    ChatInboundEvent,
    ChatParticipantProfile,
    ChatRoomProfile,
    ChatRoomRole,
    SendMessageOptions,
} from "./ChatAdapter.ts";

export const TELEGRAM_WEBHOOK_PATH = "/webhooks/telegram";

const TELEGRAM_ALLOWED_UPDATES = Object.freeze([
    "message",
    "my_chat_member",
    "chat_member",
]);

const ABSENT_MEMBER_DESCRIPTIONS = [
    "user not found",
    "participant_id_invalid",
    "user_id_invalid",
    "chat not found",
];

interface TelegramUserWire {
    readonly id?: unknown;
    readonly is_bot?: unknown;
    readonly first_name?: unknown;
    readonly last_name?: unknown;
    readonly username?: unknown;
}

interface TelegramChatWire {
    readonly id?: unknown;
    readonly type?: unknown;
    readonly title?: unknown;
}

interface TelegramEntityWire {
    readonly type?: unknown;
    readonly offset?: unknown;
    readonly length?: unknown;
}

interface TelegramChatMemberWire {
    readonly status?: unknown;
    readonly is_member?: unknown;
    readonly user?: TelegramUserWire;
}

interface TelegramChatMemberUpdatedWire {
    readonly chat?: TelegramChatWire;
    readonly from?: TelegramUserWire;
    readonly old_chat_member?: TelegramChatMemberWire;
    readonly new_chat_member?: TelegramChatMemberWire;
}

interface TelegramMessageWire {
    readonly message_id?: unknown;
    readonly from?: TelegramUserWire;
    readonly chat?: TelegramChatWire;
    readonly text?: unknown;
    readonly entities?: unknown;
    readonly caption?: unknown;
    readonly caption_entities?: unknown;
    readonly migrate_to_chat_id?: unknown;
}

interface TelegramUpdateWire {
    readonly update_id?: unknown;
    readonly message?: TelegramMessageWire;
    readonly my_chat_member?: TelegramChatMemberUpdatedWire;
    readonly chat_member?: TelegramChatMemberUpdatedWire;
}

interface TelegramApiEnvelope<T> {
    readonly ok?: unknown;
    readonly result?: T;
    readonly error_code?: unknown;
    readonly description?: unknown;
}

export interface TelegramChatAdapterOptions {
    readonly apiOrigin: string;
    readonly botToken: string;
    readonly botHandle: string;
    readonly publicOrigin: string;
    readonly fetchImpl?: typeof fetch;
}

export function deriveTelegramWebhookSecret(botToken: string, publicOrigin: string): string {
    return Buffer.from(
        hkdfSync("sha256", botToken, publicOrigin, "splurnk-telegram-webhook-v1", 32),
    ).toString("base64url");
}

function isSafeInt(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value);
}

function parseParticipant(user: TelegramUserWire | undefined): ChatParticipantProfile | null {
    if (!user || !isSafeInt(user.id)) {
        return null;
    }
    const first = typeof user.first_name === "string" ? user.first_name.trim() : "";
    const last = typeof user.last_name === "string" ? user.last_name.trim() : "";
    const combined = `${first} ${last}`.trim();
    const rawUsername = typeof user.username === "string" ? user.username.trim() : "";
    const username = rawUsername.length > 0 ? rawUsername.slice(0, 64) : null;
    const displayName = (combined || username || `Telegram User ${user.id}`).slice(0, 128);

    return {
        provider: "telegram",
        externalSubject: String(user.id),
        username,
        displayName,
        avatarUrl: null,
        isBot: user.is_bot === true,
    };
}

function parseGroupRoom(chat: TelegramChatWire | undefined): ChatRoomProfile | null {
    if (!chat || !isSafeInt(chat.id)) {
        return null;
    }
    if (chat.type !== "group" && chat.type !== "supergroup") {
        return null;
    }
    const rawTitle = typeof chat.title === "string" ? chat.title.trim() : "";
    const title = (rawTitle || `Telegram Group ${chat.id}`).slice(0, 160);
    return {
        provider: "telegram",
        externalChatId: String(chat.id),
        title,
        avatarUrl: null,
    };
}

function mapMemberRole(member: TelegramChatMemberWire | undefined): ChatRoomRole | null {
    if (!member || typeof member.status !== "string") {
        return null;
    }
    switch (member.status) {
        case "creator":
        case "administrator":
            return "admin";
        case "member":
            return "member";
        case "restricted":
            return member.is_member === true ? "member" : null;
        case "left":
        case "kicked":
        default:
            return null;
    }
}

function extractExplicitMentionPrompt(
    rawText: string,
    rawEntities: unknown,
    botHandleLower: string,
): string | null {
    if (!Array.isArray(rawEntities) || rawText.length === 0) {
        return null;
    }

    const removalSpans: Array<{ readonly start: number; readonly end: number }> = [];
    const targetMention = `@${botHandleLower}`;

    for (const item of rawEntities) {
        if (typeof item !== "object" || item === null) continue;
        const entity = item as TelegramEntityWire;
        if (
            !isSafeInt(entity.offset) ||
            !isSafeInt(entity.length) ||
            entity.offset < 0 ||
            entity.length <= 0 ||
            entity.offset + entity.length > rawText.length
        ) {
            continue;
        }
        const start = entity.offset;
        const end = entity.offset + entity.length;
        const token = rawText.slice(start, end);
        const tokenLower = token.toLowerCase();

        if (entity.type === "mention" && tokenLower === targetMention) {
            removalSpans.push({ start, end });
        } else if (entity.type === "bot_command" && tokenLower.endsWith(targetMention)) {
            removalSpans.push({ start: end - targetMention.length, end });
        }
    }

    if (removalSpans.length === 0) {
        return null;
    }

    const sorted = removalSpans.toSorted((a, b) => a.start - b.start);
    let cursor = 0;
    let assembled = "";
    for (const span of sorted) {
        if (span.start < cursor) continue;
        assembled += rawText.slice(cursor, span.start);
        cursor = span.end;
    }
    assembled += rawText.slice(cursor);
    return assembled.replace(/\s+/gu, " ").trim();
}

export default class TelegramChatAdapter implements ChatAdapter {
    readonly provider = "telegram";
    readonly #apiOrigin: string;
    readonly #botToken: string;
    readonly #botHandleLower: string;
    readonly #webhookSecret: string;
    readonly #fetch: typeof fetch;

    constructor(options: TelegramChatAdapterOptions) {
        this.#apiOrigin = options.apiOrigin;
        this.#botToken = options.botToken;
        this.#botHandleLower = options.botHandle.toLowerCase();
        this.#webhookSecret = deriveTelegramWebhookSecret(options.botToken, options.publicOrigin);
        this.#fetch = options.fetchImpl ?? globalThis.fetch;
    }

    get webhookSecret(): string {
        return this.#webhookSecret;
    }

    verifyWebhookSecret(suppliedToken: string | undefined): void {
        const candidate = suppliedToken ?? "";
        const expectedBytes = Buffer.from(this.#webhookSecret, "utf8");
        const candidateBytes = Buffer.from(candidate, "utf8");
        if (
            expectedBytes.byteLength !== candidateBytes.byteLength ||
            !timingSafeEqual(expectedBytes, candidateBytes)
        ) {
            throw new HttpError(
                401,
                "unauthorized-webhook",
                "Unauthorized",
                "Missing or invalid Telegram webhook secret token.",
            );
        }
    }

    async registerWebhook(webhookUrl: string): Promise<void> {
        await this.#callApi<boolean>("setWebhook", {
            url: webhookUrl,
            secret_token: this.#webhookSecret,
            allowed_updates: TELEGRAM_ALLOWED_UPDATES,
        });
    }

    parseUpdate(payload: unknown): readonly ChatInboundEvent[] {
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new HttpError(
                400,
                "invalid-webhook-payload",
                "Bad Request",
                "Telegram webhook body must be a JSON object.",
            );
        }

        const update = payload as TelegramUpdateWire;
        const events: ChatInboundEvent[] = [];

        if (update.my_chat_member) {
            const room = parseGroupRoom(update.my_chat_member.chat);
            if (room !== null) {
                const nextRole = mapMemberRole(update.my_chat_member.new_chat_member);
                if (nextRole !== null) {
                    const actor = parseParticipant(update.my_chat_member.from);
                    events.push({
                        kind: "bot_room_joined",
                        room,
                        actor: actor && !actor.isBot ? actor : null,
                    });
                } else {
                    events.push({
                        kind: "bot_room_left",
                        provider: this.provider,
                        externalChatId: room.externalChatId,
                    });
                }
            }
        }

        if (update.chat_member) {
            const room = parseGroupRoom(update.chat_member.chat);
            const target = parseParticipant(update.chat_member.new_chat_member?.user);
            if (room !== null && target !== null && !target.isBot) {
                events.push({
                    kind: "member_updated",
                    room,
                    member: target,
                    membership: mapMemberRole(update.chat_member.new_chat_member),
                });
            }
        }

        if (update.message) {
            const msg = update.message;
            if (msg.chat && isSafeInt(msg.chat.id) && isSafeInt(msg.migrate_to_chat_id)) {
                events.push({
                    kind: "room_migrated",
                    provider: this.provider,
                    oldExternalChatId: String(msg.chat.id),
                    newExternalChatId: String(msg.migrate_to_chat_id),
                });
                return events;
            }

            const sender = parseParticipant(msg.from);
            if (sender !== null && !sender.isBot && msg.chat && isSafeInt(msg.chat.id)) {
                if (msg.chat.type === "private") {
                    events.push({
                        kind: "direct_message",
                        externalChatId: String(msg.chat.id),
                        sender,
                        text: typeof msg.text === "string" ? msg.text : "",
                    });
                } else {
                    const room = parseGroupRoom(msg.chat);
                    if (room !== null && isSafeInt(msg.message_id)) {
                        const rawText =
                            typeof msg.text === "string"
                                ? msg.text
                                : typeof msg.caption === "string"
                                  ? msg.caption
                                  : "";
                        const rawEntities =
                            typeof msg.text === "string" ? msg.entities : msg.caption_entities;
                        const promptText = extractExplicitMentionPrompt(
                            rawText,
                            rawEntities,
                            this.#botHandleLower,
                        );
                        if (promptText !== null) {
                            events.push({
                                kind: "room_mention",
                                room,
                                sender,
                                externalMessageId: String(msg.message_id),
                                promptText,
                            });
                        }
                    }
                }
            }
        }

        return events;
    }

    async verifyRoomMember(
        externalChatId: string,
        externalSubject: string,
    ): Promise<ChatRoomRole | null> {
        if (!/^\d+$/u.test(externalSubject)) {
            return null;
        }
        const userId = Number(externalSubject);
        if (!Number.isSafeInteger(userId) || userId <= 0) {
            return null;
        }

        const response = await this.#postRaw<TelegramChatMemberWire>("getChatMember", {
            chat_id: externalChatId,
            user_id: userId,
        });
        if (!response.ok) {
            const lower = response.description.toLowerCase();
            if (
                response.status === 400 &&
                ABSENT_MEMBER_DESCRIPTIONS.some((marker) => lower.includes(marker))
            ) {
                return null;
            }
            throw new Error(
                `Telegram Bot API getChatMember failed (HTTP ${response.status}): ${response.description}`,
            );
        }

        return mapMemberRole(response.result);
    }

    async listRoomAdmins(externalChatId: string): Promise<readonly ChatParticipantProfile[]> {
        const entries = await this.#callApi<readonly TelegramChatMemberWire[]>(
            "getChatAdministrators",
            { chat_id: externalChatId },
        );
        if (!Array.isArray(entries)) {
            return [];
        }
        const admins: ChatParticipantProfile[] = [];
        for (const entry of entries) {
            if (mapMemberRole(entry) !== "admin") continue;
            const participant = parseParticipant(entry.user);
            if (participant !== null && !participant.isBot) {
                admins.push(participant);
            }
        }
        return admins;
    }

    async sendRoomMessage(
        externalChatId: string,
        text: string,
        options?: SendMessageOptions,
    ): Promise<void> {
        const replyMessageId =
            options?.replyToExternalMessageId !== undefined &&
            /^\d+$/u.test(options.replyToExternalMessageId)
                ? Number(options.replyToExternalMessageId)
                : null;
        await this.#callApi<unknown>("sendMessage", {
            chat_id: externalChatId,
            text,
            link_preview_options: { is_disabled: true },
            ...(replyMessageId !== null && Number.isSafeInteger(replyMessageId)
                ? {
                      reply_parameters: {
                          message_id: replyMessageId,
                          allow_sending_without_reply: true,
                      },
                  }
                : {}),
        });
    }

    async sendDirectNotification(externalSubject: string, text: string): Promise<void> {
        await this.#callApi<unknown>("sendMessage", {
            chat_id: externalSubject,
            text,
            link_preview_options: { is_disabled: true },
        });
    }

    #redact(message: string): string {
        return this.#botToken.length > 0
            ? message.replaceAll(this.#botToken, "[REDACTED]")
            : message;
    }

    async #postRaw<T>(
        method: string,
        body: Record<string, unknown>,
    ): Promise<
        | { readonly ok: true; readonly result: T }
        | { readonly ok: false; readonly status: number; readonly description: string }
    > {
        const endpoint = `${this.#apiOrigin}/bot${this.#botToken}/${method}`;
        let response: Response;
        try {
            response = await this.#fetch(endpoint, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json; charset=utf-8",
                },
                body: JSON.stringify(body),
            });
        } catch (error) {
            const detail = error instanceof Error ? this.#redact(error.message) : "network failure";
            throw new Error(`Telegram Bot API ${method} request failed: ${detail}`);
        }

        let parsed: TelegramApiEnvelope<T> | null = null;
        try {
            parsed = (await response.json()) as TelegramApiEnvelope<T>;
        } catch {
            parsed = null;
        }

        if (!response.ok || !parsed || parsed.ok !== true) {
            const rawDesc =
                parsed && typeof parsed.description === "string"
                    ? parsed.description
                    : `HTTP ${response.status}`;
            return {
                ok: false,
                status: response.status,
                description: this.#redact(rawDesc),
            };
        }

        return {
            ok: true,
            result: parsed.result as T,
        };
    }

    async #callApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
        const outcome = await this.#postRaw<T>(method, body);
        if (!outcome.ok) {
            throw new Error(
                `Telegram Bot API ${method} failed (HTTP ${outcome.status}): ${outcome.description}`,
            );
        }
        return outcome.result;
    }
}
