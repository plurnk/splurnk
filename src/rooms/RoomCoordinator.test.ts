import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    derivePlurnkWorkspace,
    HttpError,
    openDatabase,
    RoomCoordinator,
    type ChatAdapter,
    type ChatParticipantProfile,
    type ChatRoomRole,
    type SendMessageOptions,
} from "../index.ts";

class FakeChatAdapter implements ChatAdapter {
    readonly provider = "telegram";
    readonly memberships = new Map<string, ChatRoomRole>();
    readonly roomAdmins = new Map<string, ChatParticipantProfile[]>();
    readonly roomMessages: Array<{
        chatId: string;
        text: string;
        options: SendMessageOptions | undefined;
    }> = [];
    readonly directMessages: Array<{ subject: string; text: string }> = [];

    setRole(chatId: string, subject: string, role: ChatRoomRole | null): void {
        const key = `${chatId}:${subject}`;
        if (role === null) {
            this.memberships.delete(key);
        } else {
            this.memberships.set(key, role);
        }
    }

    async verifyRoomMember(
        externalChatId: string,
        externalSubject: string,
    ): Promise<ChatRoomRole | null> {
        return this.memberships.get(`${externalChatId}:${externalSubject}`) ?? null;
    }

    async listRoomAdmins(externalChatId: string): Promise<readonly ChatParticipantProfile[]> {
        return this.roomAdmins.get(externalChatId) ?? [];
    }

    async sendRoomMessage(
        externalChatId: string,
        text: string,
        options?: SendMessageOptions,
    ): Promise<void> {
        this.roomMessages.push({ chatId: externalChatId, text, options });
    }

    async sendDirectNotification(externalSubject: string, text: string): Promise<void> {
        this.directMessages.push({ subject: externalSubject, text });
    }
}

describe("RoomCoordinator multi-room tenancy", () => {
    test("{§splurnk-chat-seam} {§splurnk-deployment-boundary} isolates separate rooms, verifies join links live, enforces admin-only link rotation, and revokes removed members", async (t) => {
        const db = await openDatabase(":memory:");
        t.after(() => db.close());

        const adapter = new FakeChatAdapter();
        adapter.roomAdmins.set("-1001", [
            {
                provider: "telegram",
                externalSubject: "101",
                username: "alice",
                displayName: "Alice Admin",
                avatarUrl: null,
                isBot: false,
            },
        ]);
        adapter.setRole("-1001", "101", "admin");
        adapter.setRole("-1001", "103", "member");

        adapter.roomAdmins.set("-2002", [
            {
                provider: "telegram",
                externalSubject: "202",
                username: "bob",
                displayName: "Bob Admin",
                avatarUrl: null,
                isBot: false,
            },
        ]);
        adapter.setRole("-2002", "202", "admin");

        const coordinator = new RoomCoordinator({
            db,
            publicOrigin: "https://dev.splurnk.app",
            botHandle: "splurnkbot",
            roomVerifyTtlSec: 1,
            chatAdapter: adapter,
        });

        // Deterministic collision-free workspace identifiers per room.
        const wsAlpha = derivePlurnkWorkspace("telegram", "-1001");
        const wsBeta = derivePlurnkWorkspace("telegram", "-2002");
        assert.notEqual(wsAlpha, wsBeta);
        assert.match(wsAlpha, /^rm-telegram-[0-9a-f]{16}$/u);

        // 1. Bot joins Room Alpha and Room Beta.
        await coordinator.handleInboundEvents([
            {
                kind: "bot_room_joined",
                room: {
                    provider: "telegram",
                    externalChatId: "-1001",
                    title: "Alpha Kitchen",
                    avatarUrl: null,
                },
                actor: null,
            },
            {
                kind: "bot_room_joined",
                room: {
                    provider: "telegram",
                    externalChatId: "-2002",
                    title: "Beta Robotics",
                    avatarUrl: null,
                },
                actor: null,
            },
        ]);
        assert.equal(adapter.roomMessages.length, 2);
        assert.match(adapter.roomMessages[0]?.text ?? "", /\/rooms\/join\//u);

        const aliceRow = await db.getMemberBySubject.get<{
            id: number;
            provider: string;
            external_subject: string;
            username: string | null;
            display_name: string;
            avatar_url: string | null;
            is_agent: number;
        }>({ provider: "telegram", externalSubject: "101" });
        const bobRow = await db.getMemberBySubject.get<{
            id: number;
            provider: string;
            external_subject: string;
            username: string | null;
            display_name: string;
            avatar_url: string | null;
            is_agent: number;
        }>({ provider: "telegram", externalSubject: "202" });
        assert.ok(aliceRow && bobRow);

        const alice = {
            id: aliceRow.id,
            provider: aliceRow.provider,
            externalSubject: aliceRow.external_subject,
            username: aliceRow.username,
            displayName: aliceRow.display_name,
            avatarUrl: aliceRow.avatar_url,
            isAgent: false,
        };
        const bob = {
            id: bobRow.id,
            provider: bobRow.provider,
            externalSubject: bobRow.external_subject,
            username: bobRow.username,
            displayName: bobRow.display_name,
            avatarUrl: bobRow.avatar_url,
            isAgent: false,
        };

        const aliceRooms = await coordinator.listMemberRooms(alice);
        const bobRooms = await coordinator.listMemberRooms(bob);
        assert.equal(aliceRooms.length, 1);
        assert.equal(aliceRooms[0]?.title, "Alpha Kitchen");
        assert.equal(bobRooms.length, 1);
        assert.equal(bobRooms[0]?.title, "Beta Robotics");

        const alphaId = aliceRooms[0]!.id;
        const alphaJoinCode = aliceRooms[0]!.joinCode!;
        const betaId = bobRooms[0]!.id;
        const betaJoinCode = bobRooms[0]!.joinCode!;

        // 2. Hard cross-room boundary: Alice gets 404 on Beta room view, empty roster, and 404 on Beta link rotation.
        await assert.rejects(
            () => coordinator.getVerifiedMemberRoom(alice, betaId),
            (err: unknown) => err instanceof HttpError && err.status === 404,
        );
        assert.deepEqual(await coordinator.listRoomRoster(alice, betaId), []);
        await assert.rejects(
            () => coordinator.rotateJoinCode(alice, betaId),
            (err: unknown) => err instanceof HttpError && err.status === 404,
        );

        // 3. Alice cannot enroll in Beta even with Beta's joinCode because she is not in Telegram chat -2002!
        await assert.rejects(
            () => coordinator.joinRoomByCode(alice, betaJoinCode),
            (err: unknown) => err instanceof HttpError && err.status === 403,
        );

        // 4. Carol signs in via OIDC and joins Alpha via Alpha's joinCode (live getChatMember -> "member").
        const carolRow = await db.upsertMember.get<{
            id: number;
            provider: string;
            external_subject: string;
            username: string | null;
            display_name: string;
            avatar_url: string | null;
            is_agent: number;
        }>({
            provider: "telegram",
            externalSubject: "103",
            username: "carol",
            displayName: "Carol Member",
            avatarUrl: "https://t.me/i/userpic/320/carol.jpg",
            isAgent: 0,
        });
        assert.ok(carolRow);
        const carol = {
            id: carolRow.id,
            provider: carolRow.provider,
            externalSubject: carolRow.external_subject,
            username: carolRow.username,
            displayName: carolRow.display_name,
            avatarUrl: carolRow.avatar_url,
            isAgent: false,
        };

        const joinedAlpha = await coordinator.joinRoomByCode(carol, alphaJoinCode);
        assert.equal(joinedAlpha.id, alphaId);
        const alphaRoster = await coordinator.listRoomRoster(alice, alphaId);
        assert.deepEqual(
            alphaRoster.map((m) => `${m.displayName}:${m.role}`),
            ["Alice Admin:admin", "Carol Member:member"],
        );

        // 5. Carol (non-admin) cannot rotate Alpha's join link (403 admin-required); Alice (admin) can!
        await assert.rejects(
            () => coordinator.rotateJoinCode(carol, alphaId),
            (err: unknown) => err instanceof HttpError && err.status === 403,
        );
        const rotatedAlpha = await coordinator.rotateJoinCode(alice, alphaId);
        assert.notEqual(rotatedAlpha.joinCode, alphaJoinCode);
        await assert.rejects(
            () => coordinator.getActiveRoomByJoinCode(alphaJoinCode),
            (err: unknown) => err instanceof HttpError && err.status === 404,
        );

        // 6. Webhook member_updated preserves Carol's OIDC avatar when Bot API sends null avatarUrl,
        // and revokes Carol immediately when she leaves Alpha!
        await coordinator.handleInboundEvents([
            {
                kind: "member_updated",
                room: {
                    provider: "telegram",
                    externalChatId: "-1001",
                    title: "Alpha Kitchen",
                    avatarUrl: null,
                },
                member: {
                    provider: "telegram",
                    externalSubject: "103",
                    username: "carol",
                    displayName: "Carol Updated",
                    avatarUrl: null,
                    isBot: false,
                },
                membership: null,
            },
        ]);
        await assert.rejects(
            () => coordinator.getVerifiedMemberRoom(carol, alphaId),
            (err: unknown) => err instanceof HttpError && err.status === 404,
        );
        const refreshedCarol = await db.getMemberById.get<{ avatar_url: string | null }>({
            memberId: carol.id,
        });
        assert.equal(refreshedCarol?.avatar_url, "https://t.me/i/userpic/320/carol.jpg");

        // 7. Supergroup migration preserves Beta room ID & Plurnk workspace; DMs stay outbound-only.
        await coordinator.handleInboundEvents([
            {
                kind: "room_migrated",
                provider: "telegram",
                oldExternalChatId: "-2002",
                newExternalChatId: "-1002002999",
            },
            {
                kind: "direct_message",
                externalChatId: "202",
                sender: {
                    provider: "telegram",
                    externalSubject: "202",
                    username: "bob",
                    displayName: "Bob Admin",
                    avatarUrl: null,
                    isBot: false,
                },
                text: "Hello DM",
            },
        ]);
        adapter.setRole("-1002002999", "202", "admin");
        const migratedBeta = await coordinator.getVerifiedMemberRoom(bob, betaId);
        assert.equal(migratedBeta.externalChatId, "-1002002999");
        assert.equal(migratedBeta.plurnkWorkspace, wsBeta);
        assert.equal(adapter.directMessages.length, 1);
        assert.match(adapter.directMessages[0]?.text ?? "", /outbound notifications/u);

        // 8. Bot removal deactivates Beta completely.
        await coordinator.handleInboundEvents([
            {
                kind: "bot_room_left",
                provider: "telegram",
                externalChatId: "-1002002999",
            },
        ]);
        assert.deepEqual(await coordinator.listMemberRooms(bob), []);
    });

    test("{§splurnk-chat-seam} re-verifies expired memberships via ChatAdapter, enrolls non-admin install actors, and sends default mention replies", async (t) => {
        const db = await openDatabase(":memory:");
        t.after(() => db.close());

        const adapter = new FakeChatAdapter();
        adapter.setRole("-3003", "301", "member");
        adapter.setRole("-3003", "302", "admin");

        const coordinator = new RoomCoordinator({
            db,
            publicOrigin: "https://splurnk.app",
            botHandle: "splurnkbot",
            roomVerifyTtlSec: 60,
            chatAdapter: adapter,
        });

        // Install room via non-admin actor 301 and mention from admin 302 (default reply path).
        await coordinator.handleInboundEvents([
            {
                kind: "bot_room_joined",
                room: {
                    provider: "telegram",
                    externalChatId: "-3003",
                    title: "Gamma Crew",
                    avatarUrl: null,
                },
                actor: {
                    provider: "telegram",
                    externalSubject: "301",
                    username: "dan",
                    displayName: "Dan Inviter",
                    avatarUrl: null,
                    isBot: false,
                },
            },
            {
                kind: "room_mention",
                room: {
                    provider: "telegram",
                    externalChatId: "-3003",
                    title: "Gamma Crew",
                    avatarUrl: null,
                },
                sender: {
                    provider: "telegram",
                    externalSubject: "302",
                    username: "erin",
                    displayName: "Erin Lead",
                    avatarUrl: null,
                    isBot: false,
                },
                externalMessageId: "88",
                promptText: "status",
            },
        ]);

        assert.equal(adapter.roomMessages.length, 2);
        assert.equal(adapter.roomMessages[1]?.options?.replyToExternalMessageId, "88");
        assert.match(adapter.roomMessages[1]?.text ?? "", /Gamma Crew/u);

        const danRow = await db.getMemberBySubject.get<{
            id: number;
            provider: string;
            external_subject: string;
            username: string | null;
            display_name: string;
            avatar_url: string | null;
        }>({ provider: "telegram", externalSubject: "301" });
        assert.ok(danRow);
        const dan = {
            id: danRow.id,
            provider: danRow.provider,
            externalSubject: danRow.external_subject,
            username: danRow.username,
            displayName: danRow.display_name,
            avatarUrl: danRow.avatar_url,
            isAgent: false,
        };

        const roomsBefore = await coordinator.listMemberRooms(dan);
        assert.equal(roomsBefore.length, 1);
        const gammaId = roomsBefore[0]!.id;

        // Age verified_at to 0 and promote Dan to admin on Telegram -> getVerifiedMemberRoom refreshes role!
        await db.upsertRoomMember.run({
            roomId: gammaId,
            memberId: dan.id,
            role: "member",
            active: 1,
            verifiedAt: 0,
        });
        adapter.setRole("-3003", "301", "admin");
        const promoted = await coordinator.getVerifiedMemberRoom(dan, gammaId);
        assert.equal(promoted.role, "admin");

        // Age verified_at to 0 and remove Dan from Telegram -> getVerifiedMemberRoom revokes and throws 404,
        // and listMemberRooms also filters out stale revoked rooms!
        await db.upsertRoomMember.run({
            roomId: gammaId,
            memberId: dan.id,
            role: "admin",
            active: 1,
            verifiedAt: 0,
        });
        adapter.setRole("-3003", "301", null);
        await assert.rejects(
            () => coordinator.getVerifiedMemberRoom(dan, gammaId),
            (err: unknown) => err instanceof HttpError && err.status === 404,
        );

        await db.upsertRoomMember.run({
            roomId: gammaId,
            memberId: dan.id,
            role: "member",
            active: 1,
            verifiedAt: 0,
        });
        assert.deepEqual(await coordinator.listMemberRooms(dan), []);
    });
});
