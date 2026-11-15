-- MIGRATE: 1 initialSchema
CREATE TABLE members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL CHECK (
        length(trim(provider)) BETWEEN 1 AND 32
        AND provider = trim(provider)
    ),
    external_subject TEXT NOT NULL CHECK (
        length(trim(external_subject)) BETWEEN 1 AND 128
        AND external_subject = trim(external_subject)
    ),
    username TEXT CHECK (
        username IS NULL
        OR (
            length(trim(username)) BETWEEN 1 AND 64
            AND username = trim(username)
        )
    ),
    display_name TEXT NOT NULL CHECK (
        length(trim(display_name)) BETWEEN 1 AND 128
        AND display_name = trim(display_name)
    ),
    avatar_url TEXT CHECK (
        avatar_url IS NULL
        OR avatar_url GLOB 'https://*'
    ),
    is_agent INTEGER NOT NULL DEFAULT 0 CHECK (is_agent IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (provider, external_subject)
) STRICT;

CREATE TABLE rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL CHECK (
        length(trim(provider)) BETWEEN 1 AND 32
        AND provider = trim(provider)
    ),
    external_chat_id TEXT NOT NULL CHECK (
        length(trim(external_chat_id)) BETWEEN 1 AND 128
        AND external_chat_id = trim(external_chat_id)
    ),
    title TEXT NOT NULL CHECK (
        length(trim(title)) BETWEEN 1 AND 160
        AND title = trim(title)
    ),
    avatar_url TEXT CHECK (
        avatar_url IS NULL
        OR avatar_url GLOB 'https://*'
    ),
    timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (
        length(trim(timezone)) BETWEEN 1 AND 64
        AND timezone = trim(timezone)
    ),
    plurnk_workspace TEXT NOT NULL UNIQUE CHECK (
        length(trim(plurnk_workspace)) BETWEEN 1 AND 128
        AND plurnk_workspace = trim(plurnk_workspace)
    ),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (provider, external_chat_id)
) STRICT;

CREATE TABLE room_members (
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, member_id)
) STRICT;

CREATE INDEX room_members_member_id ON room_members(member_id);

CREATE TABLE sessions (
    sid_hash TEXT PRIMARY KEY CHECK (length(sid_hash) = 64),
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL CHECK (length(csrf_token) >= 32),
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX sessions_member_id ON sessions(member_id);
CREATE INDEX sessions_expires_at ON sessions(expires_at);
