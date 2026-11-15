import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openDatabase } from "./Database.ts";

describe("Database", () => {
    test("{§splurnk-configuration} {§splurnk-identity-oidc} applies initial migration idempotently and enforces STRICT schema constraints", async (t) => {
        const tempDir = await mkdtemp(join(tmpdir(), "splurnk-db-"));
        t.after(() => rm(tempDir, { recursive: true, force: true }));

        const dbFile = join(tempDir, "nested", "splurnk.db");
        const firstOpen = await openDatabase(dbFile);
        const ping = await firstOpen.healthPing.get<{ ok: number }>();
        assert.deepEqual(ping, { ok: 1 });

        const alice = await firstOpen.upsertMember.get<{
            id: number;
            provider: string;
            external_subject: string;
            username: string | null;
            display_name: string;
            avatar_url: string | null;
            is_agent: number;
        }>({
            provider: "telegram",
            externalSubject: "10001",
            username: null,
            displayName: "Alice",
            avatarUrl: null,
            isAgent: 0,
        });
        assert.ok(alice);
        assert.equal(alice.username, null);
        assert.equal(alice.display_name, "Alice");

        await firstOpen.close();

        // Re-opening existing file database must apply zero duplicate migrations and preserve rows.
        const secondOpen = await openDatabase(dbFile);
        t.after(() => secondOpen.close());

        const refreshedAlice = await secondOpen.upsertMember.get<{
            id: number;
            username: string | null;
            display_name: string;
            avatar_url: string | null;
        }>({
            provider: "telegram",
            externalSubject: "10001",
            username: "alice_tg",
            displayName: "Alice Rivera",
            avatarUrl: "https://t.me/i/userpic/320/alice.jpg",
            isAgent: 0,
        });
        assert.ok(refreshedAlice);
        assert.equal(refreshedAlice.id, alice.id);
        assert.equal(refreshedAlice.username, "alice_tg");
        assert.equal(refreshedAlice.display_name, "Alice Rivera");

        const byId = await secondOpen.getMemberById.get<{ id: number }>({ memberId: alice.id });
        assert.equal(byId?.id, alice.id);
        const bySub = await secondOpen.getMemberBySubject.get<{ id: number }>({
            provider: "telegram",
            externalSubject: "10001",
        });
        assert.equal(bySub?.id, alice.id);

        const room = await secondOpen.upsertRoom.get<{ id: number; title: string }>({
            provider: "telegram",
            externalChatId: "-100998877",
            title: "Ops Crew",
            avatarUrl: null,
            timezone: "America/New_York",
            plurnkWorkspace: "tg-100998877",
            joinCode: "ops-crew-join-code-0123456789abcdef",
        });
        assert.ok(room);

        await secondOpen.upsertRoomMember.run({
            roomId: room.id,
            memberId: alice.id,
            role: "admin",
            active: 1,
            verifiedAt: Date.now(),
        });

        const memberRooms = await secondOpen.listMemberRooms.all<{
            id: number;
            title: string;
            role: string;
        }>({ memberId: alice.id });
        assert.equal(memberRooms.length, 1);
        assert.equal(memberRooms[0]?.title, "Ops Crew");
        assert.equal(memberRooms[0]?.role, "admin");

        // Reject insecure http:// avatar URLs at the SQLite CHECK boundary.
        await assert.rejects(() =>
            secondOpen.upsertMember.get({
                provider: "telegram",
                externalSubject: "10002",
                username: "bob",
                displayName: "Bob",
                avatarUrl: "http://insecure.example/bob.png",
                isAgent: 0,
            }),
        );
    });
});
