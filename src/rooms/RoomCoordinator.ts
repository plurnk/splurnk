// {§splurnk-chat-seam} {§splurnk-deployment-boundary}
// Transport-neutral room enrollment, live membership re-verification, and multi-room tenancy guard.
import { createHash, randomBytes } from "node:crypto";
import type SqlRite from "@possumtech/sqlrite";
import type ChatAdapter from "../chat/ChatAdapter.ts";
import type {
    ChatInboundEvent,
    ChatParticipantProfile,
    ChatRoomProfile,
    ChatRoomRole,
} from "../chat/ChatAdapter.ts";
import type {
    EnrolledRoom,
    MemberRecord,
    RoomRecord,
    RoomRosterMember,
} from "../Database.ts";
import HttpError from "../HttpError.ts";

const JOIN_CODE_PATTERN = /^[\w-]{22,128}$/u;

interface RoomRow {
    readonly id: number;
    readonly provider: string;
    readonly external_chat_id: string;
    readonly title: string;
    readonly avatar_url: string | null;
    readonly timezone: string;
    readonly plurnk_workspace: string;
    readonly join_code: string | null;
    readonly active: number;
}

interface EnrolledRoomRow {
    readonly id: number;
    readonly provider: string;
    readonly external_chat_id: string;
    readonly title: string;
    readonly avatar_url: string | null;
    readonly timezone: string;
    readonly plurnk_workspace: string;
    readonly join_code: string | null;
    readonly role: ChatRoomRole;
    readonly verified_at: number;
}

interface MemberRow {
    readonly id: number;
    readonly provider: string;
    readonly external_subject: string;
    readonly username: string | null;
    readonly display_name: string;
    readonly avatar_url: string | null;
    readonly is_agent: number;
}

interface RosterMemberRow extends MemberRow {
    readonly role: ChatRoomRole;
}

export interface RoomMentionContext {
    readonly room: RoomRecord;
    readonly sender: MemberRecord;
    readonly senderRole: ChatRoomRole;
    readonly externalMessageId: string;
    readonly promptText: string;
}

export type RoomMentionHandler = (context: RoomMentionContext) => Promise<string | null>;

export interface RoomCoordinatorOptions {
    readonly db: SqlRite;
    readonly publicOrigin: string;
    readonly botHandle: string;
    readonly roomVerifyTtlSec: number;
    readonly chatAdapter: ChatAdapter | null;
    readonly onRoomMention?: RoomMentionHandler | undefined;
}

export function derivePlurnkWorkspace(provider: string, externalChatId: string): string {
    const safeProvider =
        provider
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, "-")
            .replace(/^-+|-+$/gu, "")
            .slice(0, 16) || "chat";
    const digest = createHash("sha256")
        .update(`${provider}:${externalChatId}`, "utf8")
        .digest("hex")
        .slice(0, 16);
    return `rm-${safeProvider}-${digest}`;
}

export function mintRoomJoinCode(): string {
    return randomBytes(32).toString("base64url");
}

function toRoomRecord(row: RoomRow): RoomRecord {
    return {
        id: row.id,
        provider: row.provider,
        externalChatId: row.external_chat_id,
        title: row.title,
        avatarUrl: row.avatar_url,
        timezone: row.timezone,
        plurnkWorkspace: row.plurnk_workspace,
        joinCode: row.join_code,
        active: row.active === 1,
    };
}

function toEnrolledRoom(row: EnrolledRoomRow): EnrolledRoom {
    return {
        id: row.id,
        provider: row.provider,
        externalChatId: row.external_chat_id,
        title: row.title,
        avatarUrl: row.avatar_url,
        timezone: row.timezone,
        plurnkWorkspace: row.plurnk_workspace,
        joinCode: row.join_code,
        role: row.role,
        verifiedAt: row.verified_at,
    };
}

function toMemberRecord(row: MemberRow): MemberRecord {
    return {
        id: row.id,
        provider: row.provider,
        externalSubject: row.external_subject,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        isAgent: row.is_agent === 1,
    };
}

export default class RoomCoordinator {
    readonly #db: SqlRite;
    readonly #publicOrigin: string;
    readonly #botHandle: string;
    readonly #verifyTtlMs: number;
    readonly #chatAdapter: ChatAdapter | null;
    readonly #onRoomMention: RoomMentionHandler | undefined;

    constructor(options: RoomCoordinatorOptions) {
        this.#db = options.db;
        this.#publicOrigin = options.publicOrigin;
        this.#botHandle = options.botHandle;
        this.#verifyTtlMs = options.roomVerifyTtlSec * 1000;
        this.#chatAdapter = options.chatAdapter;
        this.#onRoomMention = options.onRoomMention;
    }

    get chatConfigured(): boolean {
        return this.#chatAdapter !== null;
    }

    buildJoinUrl(joinCode: string): string {
        return `${this.#publicOrigin}/rooms/join/${encodeURIComponent(joinCode)}`;
    }

    async handleInboundEvents(events: readonly ChatInboundEvent[]): Promise<void> {
        for (const event of events) {
            switch (event.kind) {
                case "bot_room_joined":
                    await this.#handleBotRoomJoined(event.room, event.actor);
                    break;
                case "bot_room_left":
                    await this.#db.deactivateRoom.run({
                        provider: event.provider,
                        externalChatId: event.externalChatId,
                    });
                    break;
                case "room_migrated":
                    await this.#db.migrateRoomExternalChatId.run({
                        provider: event.provider,
                        oldExternalChatId: event.oldExternalChatId,
                        newExternalChatId: event.newExternalChatId,
                    });
                    break;
                case "member_updated":
                    await this.#handleMemberUpdated(event.room, event.member, event.membership);
                    break;
                case "room_mention":
                    await this.#handleRoomMention(
                        event.room,
                        event.sender,
                        event.externalMessageId,
                        event.promptText,
                    );
                    break;
                case "direct_message":
                    await this.#handleDirectMessage(event.sender);
                    break;
            }
        }
    }

    async listMemberRooms(member: MemberRecord): Promise<EnrolledRoom[]> {
        const rows = await this.#db.listMemberRooms.all<EnrolledRoomRow>({
            memberId: member.id,
        });
        const now = Date.now();
        const verified: EnrolledRoom[] = [];

        for (const row of rows) {
            const room = toEnrolledRoom(row);
            if (
                this.#chatAdapter !== null &&
                this.#chatAdapter.provider === room.provider &&
                now - room.verifiedAt >= this.#verifyTtlMs
            ) {
                const refreshed = await this.#tryRefreshMembership(room, member, now);
                if (refreshed !== null) {
                    verified.push(refreshed);
                }
            } else {
                verified.push(room);
            }
        }
        return verified;
    }

    async getVerifiedMemberRoom(member: MemberRecord, roomId: number): Promise<EnrolledRoom> {
        const row = await this.#db.getMemberRoom.get<EnrolledRoomRow>({
            roomId,
            memberId: member.id,
        });
        if (!row) {
            throw new HttpError(404, "not-found", "Not Found", "Room not found.");
        }

        const room = toEnrolledRoom(row);
        const now = Date.now();
        if (
            this.#chatAdapter !== null &&
            this.#chatAdapter.provider === room.provider &&
            now - room.verifiedAt >= this.#verifyTtlMs
        ) {
            const liveRole = await this.#chatAdapter.verifyRoomMember(
                room.externalChatId,
                member.externalSubject,
            );
            if (liveRole === null) {
                await this.#db.upsertRoomMember.run({
                    roomId: room.id,
                    memberId: member.id,
                    role: "member",
                    active: 0,
                    verifiedAt: now,
                });
                throw new HttpError(404, "not-found", "Not Found", "Room not found.");
            }
            await this.#db.upsertRoomMember.run({
                roomId: room.id,
                memberId: member.id,
                role: liveRole,
                active: 1,
                verifiedAt: now,
            });
            return {
                ...room,
                role: liveRole,
                verifiedAt: now,
            };
        }

        return room;
    }

    async listRoomRoster(actor: MemberRecord, roomId: number): Promise<RoomRosterMember[]> {
        const rows = await this.#db.listRoomMembers.all<RosterMemberRow>({
            roomId,
            actorMemberId: actor.id,
        });
        return rows.map((row) => ({
            ...toMemberRecord(row),
            role: row.role,
        }));
    }

    async getActiveRoomByJoinCode(joinCode: string): Promise<RoomRecord> {
        if (!JOIN_CODE_PATTERN.test(joinCode)) {
            throw new HttpError(404, "not-found", "Not Found", "Room join link is invalid or expired.");
        }
        const row = await this.#db.getRoomByJoinCode.get<RoomRow>({ joinCode });
        if (!row) {
            throw new HttpError(404, "not-found", "Not Found", "Room join link is invalid or expired.");
        }
        return toRoomRecord(row);
    }

    async isMemberEnrolled(memberId: number, roomId: number): Promise<boolean> {
        const row = await this.#db.getMemberRoom.get<EnrolledRoomRow>({ roomId, memberId });
        return Boolean(row);
    }

    async joinRoomByCode(member: MemberRecord, joinCode: string): Promise<RoomRecord> {
        const room = await this.getActiveRoomByJoinCode(joinCode);
        if (this.#chatAdapter === null || this.#chatAdapter.provider !== room.provider) {
            throw new HttpError(
                503,
                "chat-adapter-unconfigured",
                "Service Unavailable",
                "Chat membership verification is not configured on this instance.",
            );
        }

        const now = Date.now();
        const liveRole = await this.#chatAdapter.verifyRoomMember(
            room.externalChatId,
            member.externalSubject,
        );
        if (liveRole === null) {
            await this.#db.upsertRoomMember.run({
                roomId: room.id,
                memberId: member.id,
                role: "member",
                active: 0,
                verifiedAt: now,
            });
            throw new HttpError(
                403,
                "not-room-member",
                "Forbidden",
                `Your ${room.provider} account is not an active member of "${room.title}".`,
            );
        }

        await this.#db.upsertRoomMember.run({
            roomId: room.id,
            memberId: member.id,
            role: liveRole,
            active: 1,
            verifiedAt: now,
        });
        return room;
    }

    async rotateJoinCode(actor: MemberRecord, roomId: number): Promise<RoomRecord> {
        const existing = await this.#db.getMemberRoom.get<EnrolledRoomRow>({
            roomId,
            memberId: actor.id,
        });
        if (!existing) {
            throw new HttpError(404, "not-found", "Not Found", "Room not found.");
        }

        const now = Date.now();
        let verifiedRole: ChatRoomRole = existing.role;
        if (this.#chatAdapter !== null && this.#chatAdapter.provider === existing.provider) {
            const liveRole = await this.#chatAdapter.verifyRoomMember(
                existing.external_chat_id,
                actor.externalSubject,
            );
            if (liveRole === null) {
                await this.#db.upsertRoomMember.run({
                    roomId,
                    memberId: actor.id,
                    role: "member",
                    active: 0,
                    verifiedAt: now,
                });
                throw new HttpError(404, "not-found", "Not Found", "Room not found.");
            }
            verifiedRole = liveRole;
            await this.#db.upsertRoomMember.run({
                roomId,
                memberId: actor.id,
                role: liveRole,
                active: 1,
                verifiedAt: now,
            });
        }

        if (verifiedRole !== "admin") {
            throw new HttpError(
                403,
                "admin-required",
                "Forbidden",
                "Only verified room administrators may rotate a room join link.",
            );
        }

        const rotated = await this.#db.rotateRoomJoinCode.get<RoomRow>({
            roomId,
            actorMemberId: actor.id,
            joinCode: mintRoomJoinCode(),
        });
        if (!rotated) {
            throw new HttpError(404, "not-found", "Not Found", "Room not found.");
        }
        return toRoomRecord(rotated);
    }

    async #tryRefreshMembership(
        room: EnrolledRoom,
        member: MemberRecord,
        now: number,
    ): Promise<EnrolledRoom | null> {
        if (this.#chatAdapter === null) {
            return room;
        }
        let liveRole: ChatRoomRole | null;
        try {
            liveRole = await this.#chatAdapter.verifyRoomMember(
                room.externalChatId,
                member.externalSubject,
            );
        } catch {
            return room;
        }

        if (liveRole === null) {
            await this.#db.upsertRoomMember.run({
                roomId: room.id,
                memberId: member.id,
                role: "member",
                active: 0,
                verifiedAt: now,
            });
            return null;
        }

        await this.#db.upsertRoomMember.run({
            roomId: room.id,
            memberId: member.id,
            role: liveRole,
            active: 1,
            verifiedAt: now,
        });
        return {
            ...room,
            role: liveRole,
            verifiedAt: now,
        };
    }

    async #ensureRoom(profile: ChatRoomProfile): Promise<{
        readonly room: RoomRecord;
        readonly wasActive: boolean;
    }> {
        const prior = await this.#db.getRoomByExternalId.get<RoomRow>({
            provider: profile.provider,
            externalChatId: profile.externalChatId,
        });
        const wasActive = prior?.active === 1;
        const upserted = await this.#db.upsertRoom.get<RoomRow>({
            provider: profile.provider,
            externalChatId: profile.externalChatId,
            title: profile.title,
            avatarUrl: profile.avatarUrl,
            timezone: "UTC",
            plurnkWorkspace: derivePlurnkWorkspace(profile.provider, profile.externalChatId),
            joinCode: mintRoomJoinCode(),
        });
        if (!upserted) {
            throw new Error("upsertRoom failed to return the persisted room row.");
        }
        return { room: toRoomRecord(upserted), wasActive };
    }

    async #upsertParticipant(participant: ChatParticipantProfile): Promise<MemberRecord> {
        const row = await this.#db.upsertChatParticipant.get<MemberRow>({
            provider: participant.provider,
            externalSubject: participant.externalSubject,
            username: participant.username,
            displayName: participant.displayName,
            avatarUrl: participant.avatarUrl,
            isAgent: participant.isBot ? 1 : 0,
        });
        if (!row) {
            throw new Error("upsertMember failed to return the persisted member row.");
        }
        return toMemberRecord(row);
    }

    async #syncRoomAdmins(room: RoomRecord): Promise<Set<number>> {
        const syncedAdminIds = new Set<number>();
        if (this.#chatAdapter === null || this.#chatAdapter.provider !== room.provider) {
            return syncedAdminIds;
        }
        const admins = await this.#chatAdapter.listRoomAdmins(room.externalChatId);
        const now = Date.now();
        for (const adminProfile of admins) {
            const member = await this.#upsertParticipant(adminProfile);
            syncedAdminIds.add(member.id);
            await this.#db.upsertRoomMember.run({
                roomId: room.id,
                memberId: member.id,
                role: "admin",
                active: 1,
                verifiedAt: now,
            });
        }
        await this.#db.demoteAbsentRoomAdmins.run({
            roomId: room.id,
            adminMemberIdsJson: JSON.stringify([...syncedAdminIds]),
        });
        return syncedAdminIds;
    }

    async #handleBotRoomJoined(
        roomProfile: ChatRoomProfile,
        actorProfile: ChatParticipantProfile | null,
    ): Promise<void> {
        const { room, wasActive } = await this.#ensureRoom(roomProfile);
        const adminIds = await this.#syncRoomAdmins(room);

        if (actorProfile !== null && !actorProfile.isBot) {
            const actor = await this.#upsertParticipant(actorProfile);
            if (!adminIds.has(actor.id)) {
                const liveRole =
                    this.#chatAdapter !== null && this.#chatAdapter.provider === room.provider
                        ? ((await this.#chatAdapter.verifyRoomMember(
                              room.externalChatId,
                              actor.externalSubject,
                          )) ?? "member")
                        : "member";
                await this.#db.upsertRoomMember.run({
                    roomId: room.id,
                    memberId: actor.id,
                    role: liveRole,
                    active: 1,
                    verifiedAt: Date.now(),
                });
            }
        }

        if (!wasActive && this.#chatAdapter !== null && room.joinCode !== null) {
            const joinUrl = this.buildJoinUrl(room.joinCode);
            await this.#chatAdapter.sendRoomMessage(
                room.externalChatId,
                `Splurnk is active for "${room.title}". Enroll on the task board: ${joinUrl} — tag @${this.#botHandle} here anytime to coordinate together.`,
            );
        }
    }

    async #handleMemberUpdated(
        roomProfile: ChatRoomProfile,
        memberProfile: ChatParticipantProfile,
        membership: ChatRoomRole | null,
    ): Promise<void> {
        const existing = await this.#db.getRoomByExternalId.get<RoomRow>({
            provider: roomProfile.provider,
            externalChatId: roomProfile.externalChatId,
        });
        if (!existing || existing.active !== 1) {
            return;
        }
        const member = await this.#upsertParticipant(memberProfile);
        const now = Date.now();
        await this.#db.upsertRoomMember.run({
            roomId: existing.id,
            memberId: member.id,
            role: membership ?? "member",
            active: membership === null ? 0 : 1,
            verifiedAt: now,
        });
    }

    async #handleRoomMention(
        roomProfile: ChatRoomProfile,
        senderProfile: ChatParticipantProfile,
        externalMessageId: string,
        promptText: string,
    ): Promise<void> {
        const { room, wasActive } = await this.#ensureRoom(roomProfile);
        if (!wasActive) {
            await this.#syncRoomAdmins(room);
        }

        const sender = await this.#upsertParticipant(senderProfile);
        let senderRole: ChatRoomRole = "member";
        if (this.#chatAdapter !== null && this.#chatAdapter.provider === room.provider) {
            senderRole =
                (await this.#chatAdapter.verifyRoomMember(
                    room.externalChatId,
                    sender.externalSubject,
                )) ?? "member";
        }

        await this.#db.upsertRoomMember.run({
            roomId: room.id,
            memberId: sender.id,
            role: senderRole,
            active: 1,
            verifiedAt: Date.now(),
        });

        let replyText: string | null;
        if (this.#onRoomMention !== undefined) {
            replyText = await this.#onRoomMention({
                room,
                sender,
                senderRole,
                externalMessageId,
                promptText,
            });
        } else {
            const joinSuffix =
                room.joinCode !== null ? ` Join link: ${this.buildJoinUrl(room.joinCode)}` : "";
            replyText = `"${room.title}" is enrolled on ${this.#publicOrigin} (workspace ${room.plurnkWorkspace}#room).${joinSuffix}`;
        }

        if (replyText !== null && this.#chatAdapter !== null) {
            await this.#chatAdapter.sendRoomMessage(room.externalChatId, replyText, {
                replyToExternalMessageId: externalMessageId,
            });
        }
    }

    async #handleDirectMessage(senderProfile: ChatParticipantProfile): Promise<void> {
        await this.#upsertParticipant(senderProfile);
        if (this.#chatAdapter === null) {
            return;
        }
        await this.#chatAdapter.sendDirectNotification(
            senderProfile.externalSubject,
            `Direct messages from @${this.#botHandle} deliver outbound notifications, alerts, and check-ins only. Sign in at ${this.#publicOrigin} to manage tasks or chat with @${this.#botHandle}.`,
        );
    }
}
