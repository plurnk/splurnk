// {§splurnk-configuration} {§splurnk-identity-oidc} {§splurnk-chat-seam}
// SqlRite persistence opener resolving package-relative migration and query directories.
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import SqlRite from "@possumtech/sqlrite";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const SQL_DIR = fileURLToPath(new URL("../sql", import.meta.url));

export interface MemberRecord {
    readonly id: number;
    readonly provider: string;
    readonly externalSubject: string;
    readonly username: string | null;
    readonly displayName: string;
    readonly avatarUrl: string | null;
    readonly isAgent: boolean;
}

export interface RoomRecord {
    readonly id: number;
    readonly provider: string;
    readonly externalChatId: string;
    readonly title: string;
    readonly avatarUrl: string | null;
    readonly timezone: string;
    readonly plurnkWorkspace: string;
    readonly joinCode: string | null;
    readonly active: boolean;
}

export interface EnrolledRoom {
    readonly id: number;
    readonly provider: string;
    readonly externalChatId: string;
    readonly title: string;
    readonly avatarUrl: string | null;
    readonly timezone: string;
    readonly plurnkWorkspace: string;
    readonly joinCode: string | null;
    readonly role: "admin" | "member";
    readonly verifiedAt: number;
}

export interface RoomRosterMember extends MemberRecord {
    readonly role: "admin" | "member";
}

export async function openDatabase(dbPath: string): Promise<SqlRite> {
    if (dbPath !== ":memory:") {
        await mkdir(dirname(resolve(dbPath)), { recursive: true });
    }
    return await SqlRite.open({
        path: dbPath,
        dir: [MIGRATIONS_DIR, SQL_DIR],
        enableForeignKeyConstraints: true,
    });
}
