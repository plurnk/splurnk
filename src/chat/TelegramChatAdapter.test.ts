import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    deriveTelegramWebhookSecret,
    HttpError,
    TelegramChatAdapter,
} from "../index.ts";

interface RecordedCall {
    readonly url: string;
    readonly body: Record<string, unknown>;
}

describe("TelegramChatAdapter", () => {
    test("{§splurnk-chat-seam} {§splurnk-configuration} verifies HKDF webhook secrets in constant time and registers setWebhook", async () => {
        const calls: RecordedCall[] = [];
        const secretTokenValue = "999888:SUPER_SECRET_BOT_TOKEN";
        const adapter = new TelegramChatAdapter({
            apiOrigin: "https://api.telegram.org",
            botToken: secretTokenValue,
            botHandle: "splurnkbot",
            publicOrigin: "https://dev.splurnk.app",
            fetchImpl: async (input, init) => {
                calls.push({
                    url: String(input),
                    body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
                });
                return new Response(JSON.stringify({ ok: true, result: true }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            },
        });

        const expected = deriveTelegramWebhookSecret(secretTokenValue, "https://dev.splurnk.app");
        assert.equal(adapter.webhookSecret, expected);
        adapter.verifyWebhookSecret(expected);

        for (const bad of [undefined, "", "short", `${expected.slice(0, -1)}X`]) {
            assert.throws(
                () => adapter.verifyWebhookSecret(bad),
                (err: unknown) => err instanceof HttpError && err.status === 401,
            );
        }

        await adapter.registerWebhook("https://dev.splurnk.app/webhooks/telegram");
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0]?.body, {
            url: "https://dev.splurnk.app/webhooks/telegram",
            secret_token: expected,
            allowed_updates: ["message", "my_chat_member", "chat_member"],
        });
    });

    test("{§splurnk-chat-seam} ignores unmentioned group chatter (6.B) and parses explicit mentions, lifecycle updates, migrations, and DMs", () => {
        const adapter = new TelegramChatAdapter({
            apiOrigin: "https://api.telegram.org",
            botToken: "123:tok",
            botHandle: "SplurnkBot",
            publicOrigin: "https://splurnk.app",
        });

        assert.throws(() => adapter.parseUpdate(null), HttpError);
        assert.throws(() => adapter.parseUpdate([]), HttpError);

        // 1. General group chatter without @SplurnkBot -> ignored completely.
        assert.deepEqual(
            adapter.parseUpdate({
                update_id: 1,
                message: {
                    message_id: 10,
                    from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
                    chat: { id: -100500, type: "supergroup", title: "Analytical Engine" },
                    text: "Good morning team, any coffee left?",
                },
            }),
            [],
        );

        // 2. Bare slash command or mention of a different bot -> ignored completely.
        assert.deepEqual(
            adapter.parseUpdate({
                update_id: 2,
                message: {
                    message_id: 11,
                    from: { id: 42, is_bot: false, first_name: "Ada" },
                    chat: { id: -100500, type: "supergroup", title: "Analytical Engine" },
                    text: "/status @otherbot check",
                    entities: [
                        { type: "bot_command", offset: 0, length: 7 },
                        { type: "mention", offset: 8, length: 9 },
                    ],
                },
            }),
            [],
        );

        // 3. Explicit @splurnkbot mention with UTF-16 emoji prefix -> parsed cleanly.
        const mentionText = "🚀 @splurnkbot schedule weekly review";
        const mentionOffset = mentionText.indexOf("@splurnkbot");
        assert.deepEqual(
            adapter.parseUpdate({
                update_id: 3,
                message: {
                    message_id: 12,
                    from: {
                        id: 42,
                        is_bot: false,
                        first_name: "Ada",
                        last_name: "Lovelace",
                        username: "ada",
                    },
                    chat: { id: -100500, type: "supergroup", title: "Analytical Engine" },
                    text: mentionText,
                    entities: [{ type: "mention", offset: mentionOffset, length: 11 }],
                },
            }),
            [
                {
                    kind: "room_mention",
                    room: {
                        provider: "telegram",
                        externalChatId: "-100500",
                        title: "Analytical Engine",
                        avatarUrl: null,
                    },
                    sender: {
                        provider: "telegram",
                        externalSubject: "42",
                        username: "ada",
                        displayName: "Ada Lovelace",
                        avatarUrl: null,
                        isBot: false,
                    },
                    externalMessageId: "12",
                    promptText: "🚀 schedule weekly review",
                },
            ],
        );

        // 4. Explicit /plan@SplurnkBot command in caption -> parsed cleanly.
        const captionText = "/plan@SplurnkBot Dish duty";
        assert.deepEqual(
            adapter.parseUpdate({
                update_id: 4,
                message: {
                    message_id: 13,
                    from: { id: 77, is_bot: false, first_name: "Charles" },
                    chat: { id: -999, type: "group", title: "Babbage Lab" },
                    caption: captionText,
                    caption_entities: [{ type: "bot_command", offset: 0, length: 16 }],
                },
            }),
            [
                {
                    kind: "room_mention",
                    room: {
                        provider: "telegram",
                        externalChatId: "-999",
                        title: "Babbage Lab",
                        avatarUrl: null,
                    },
                    sender: {
                        provider: "telegram",
                        externalSubject: "77",
                        username: null,
                        displayName: "Charles",
                        avatarUrl: null,
                        isBot: false,
                    },
                    externalMessageId: "13",
                    promptText: "/plan Dish duty",
                },
            ],
        );

        // 5. Bot join, bot leave, member update, supergroup migration, and private DM.
        const joinEvents = adapter.parseUpdate({
            update_id: 5,
            my_chat_member: {
                chat: { id: -999, type: "group", title: "Babbage Lab" },
                from: { id: 42, is_bot: false, first_name: "Ada" },
                old_chat_member: { status: "left", user: { id: 1, is_bot: true } },
                new_chat_member: { status: "member", user: { id: 1, is_bot: true } },
            },
        });
        assert.equal(joinEvents[0]?.kind, "bot_room_joined");

        const leaveEvents = adapter.parseUpdate({
            update_id: 6,
            my_chat_member: {
                chat: { id: -999, type: "group", title: "Babbage Lab" },
                from: { id: 42, is_bot: false, first_name: "Ada" },
                new_chat_member: { status: "kicked", user: { id: 1, is_bot: true } },
            },
        });
        assert.deepEqual(leaveEvents, [
            { kind: "bot_room_left", provider: "telegram", externalChatId: "-999" },
        ]);

        const memberUpdate = adapter.parseUpdate({
            update_id: 7,
            chat_member: {
                chat: { id: -100500, type: "supergroup", title: "Analytical Engine" },
                new_chat_member: {
                    status: "restricted",
                    is_member: true,
                    user: { id: 88, is_bot: false, first_name: "Mary" },
                },
            },
        });
        assert.equal(memberUpdate[0]?.kind, "member_updated");
        if (memberUpdate[0]?.kind === "member_updated") {
            assert.equal(memberUpdate[0].membership, "member");
        }

        const migrationEvents = adapter.parseUpdate({
            update_id: 8,
            message: {
                message_id: 14,
                chat: { id: -999, type: "group", title: "Babbage Lab" },
                migrate_to_chat_id: -100999888,
            },
        });
        assert.deepEqual(migrationEvents, [
            {
                kind: "room_migrated",
                provider: "telegram",
                oldExternalChatId: "-999",
                newExternalChatId: "-100999888",
            },
        ]);

        const dmEvents = adapter.parseUpdate({
            update_id: 9,
            message: {
                message_id: 15,
                from: { id: 42, is_bot: false, first_name: "Ada" },
                chat: { id: 42, type: "private" },
                text: "/start",
            },
        });
        assert.deepEqual(dmEvents, [
            {
                kind: "direct_message",
                externalChatId: "42",
                sender: {
                    provider: "telegram",
                    externalSubject: "42",
                    username: null,
                    displayName: "Ada",
                    avatarUrl: null,
                    isBot: false,
                },
                text: "/start",
            },
        ]);
    });

    test("{§splurnk-chat-seam} {§splurnk-configuration} verifies live room roles, filters bot admins, sends messages, and redacts bot tokens on errors", async () => {
        const sensitiveToken = "777111:SENSITIVE_TOKEN_VALUE";
        const outboundBodies: Array<{ method: string; body: Record<string, unknown> }> = [];
        let mode: "ok" | "not-found" | "500" | "network-throw" = "ok";
        let memberStatus: { status: string; is_member?: boolean } = { status: "administrator" };

        const adapter = new TelegramChatAdapter({
            apiOrigin: "https://api.telegram.org",
            botToken: sensitiveToken,
            botHandle: "splurnkbot",
            publicOrigin: "https://dev.splurnk.app",
            fetchImpl: async (input, init) => {
                const url = String(input);
                const method = url.split("/").at(-1) ?? "";
                const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
                outboundBodies.push({ method, body });

                if (mode === "network-throw") {
                    throw new Error(`connect ECONNREFUSED ${url}`);
                }
                if (mode === "500") {
                    return new Response(
                        JSON.stringify({
                            ok: false,
                            error_code: 502,
                            description: `Upstream gateway error for ${sensitiveToken}`,
                        }),
                        { status: 502, headers: { "Content-Type": "application/json" } },
                    );
                }
                if (method === "getChatMember") {
                    if (mode === "not-found") {
                        return new Response(
                            JSON.stringify({
                                ok: false,
                                error_code: 400,
                                description: "Bad Request: user not found",
                            }),
                            { status: 400, headers: { "Content-Type": "application/json" } },
                        );
                    }
                    return new Response(JSON.stringify({ ok: true, result: memberStatus }), {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                if (method === "getChatAdministrators") {
                    return new Response(
                        JSON.stringify({
                            ok: true,
                            result: [
                                {
                                    status: "creator",
                                    user: { id: 10, is_bot: false, first_name: "Grace" },
                                },
                                {
                                    status: "administrator",
                                    user: { id: 99, is_bot: true, first_name: "SplurnkBot" },
                                },
                            ],
                        }),
                        { status: 200, headers: { "Content-Type": "application/json" } },
                    );
                }
                return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            },
        });

        assert.equal(await adapter.verifyRoomMember("-1001", "not-a-number"), null);
        assert.equal(await adapter.verifyRoomMember("-1001", "10"), "admin");

        memberStatus = { status: "restricted", is_member: false };
        assert.equal(await adapter.verifyRoomMember("-1001", "10"), null);

        mode = "not-found";
        assert.equal(await adapter.verifyRoomMember("-1001", "10"), null);

        mode = "ok";
        const admins = await adapter.listRoomAdmins("-1001");
        assert.equal(admins.length, 1);
        assert.equal(admins[0]?.displayName, "Grace");

        await adapter.sendRoomMessage("-1001", "Room notice", {
            replyToExternalMessageId: "55",
        });
        await adapter.sendDirectNotification("10", "Direct check-in");
        assert.deepEqual(outboundBodies.at(-2)?.body.reply_parameters, {
            message_id: 55,
            allow_sending_without_reply: true,
        });
        assert.equal(outboundBodies.at(-1)?.body.chat_id, "10");

        // Verify strict token redaction on both HTTP 5xx and thrown network errors.
        mode = "500";
        await assert.rejects(
            () => adapter.verifyRoomMember("-1001", "10"),
            (err: unknown) =>
                err instanceof Error &&
                !err.message.includes(sensitiveToken) &&
                err.message.includes("[REDACTED]"),
        );

        mode = "network-throw";
        await assert.rejects(
            () => adapter.sendDirectNotification("10", "ping"),
            (err: unknown) =>
                err instanceof Error &&
                !err.message.includes(sensitiveToken) &&
                err.message.includes("[REDACTED]"),
        );
    });
});
