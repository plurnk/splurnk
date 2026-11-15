-- PREP: upsertRoom
INSERT INTO rooms (
    provider,
    external_chat_id,
    title,
    avatar_url,
    timezone,
    plurnk_workspace,
    active
)
VALUES (
    $provider,
    $externalChatId,
    $title,
    $avatarUrl,
    $timezone,
    $plurnkWorkspace,
    1
)
ON CONFLICT(provider, external_chat_id) DO UPDATE SET
    title = excluded.title,
    avatar_url = excluded.avatar_url,
    timezone = excluded.timezone,
    active = 1,
    updated_at = datetime('now')
RETURNING
    id,
    provider,
    external_chat_id,
    title,
    avatar_url,
    timezone,
    plurnk_workspace,
    active;

-- PREP: upsertRoomMember
INSERT INTO room_members (
    room_id,
    member_id,
    role,
    active
)
VALUES (
    $roomId,
    $memberId,
    $role,
    $active
)
ON CONFLICT(room_id, member_id) DO UPDATE SET
    role = excluded.role,
    active = excluded.active,
    updated_at = datetime('now');

-- PREP: listMemberRooms
SELECT
    r.id,
    r.provider,
    r.external_chat_id,
    r.title,
    r.avatar_url,
    r.timezone,
    r.plurnk_workspace,
    rm.role
FROM room_members AS rm
JOIN rooms AS r
  ON r.id = rm.room_id
WHERE rm.member_id = $memberId
  AND rm.active = 1
  AND r.active = 1
ORDER BY r.title COLLATE NOCASE, r.id;
