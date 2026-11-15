-- PREP: upsertRoom
INSERT INTO rooms (
    provider,
    external_chat_id,
    title,
    avatar_url,
    timezone,
    plurnk_workspace,
    join_code,
    active
)
VALUES (
    $provider,
    $externalChatId,
    $title,
    $avatarUrl,
    $timezone,
    $plurnkWorkspace,
    $joinCode,
    1
)
ON CONFLICT(provider, external_chat_id) DO UPDATE SET
    title = excluded.title,
    avatar_url = excluded.avatar_url,
    join_code = COALESCE(rooms.join_code, excluded.join_code),
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
    join_code,
    active;

-- PREP: getRoomByExternalId
SELECT
    id,
    provider,
    external_chat_id,
    title,
    avatar_url,
    timezone,
    plurnk_workspace,
    join_code,
    active
FROM rooms
WHERE provider = $provider
  AND external_chat_id = $externalChatId;

-- PREP: getRoomByJoinCode
SELECT
    id,
    provider,
    external_chat_id,
    title,
    avatar_url,
    timezone,
    plurnk_workspace,
    join_code,
    active
FROM rooms
WHERE join_code = $joinCode
  AND active = 1;

-- PREP: deactivateRoom
UPDATE rooms
SET active = 0,
    updated_at = datetime('now')
WHERE provider = $provider
  AND external_chat_id = $externalChatId;

-- PREP: migrateRoomExternalChatId
UPDATE rooms
SET external_chat_id = $newExternalChatId,
    updated_at = datetime('now')
WHERE provider = $provider
  AND external_chat_id = $oldExternalChatId
  AND NOT EXISTS (
      SELECT 1
      FROM rooms AS existing
      WHERE existing.provider = $provider
        AND existing.external_chat_id = $newExternalChatId
  );

-- PREP: rotateRoomJoinCode
UPDATE rooms
SET join_code = $joinCode,
    updated_at = datetime('now')
WHERE id = $roomId
  AND active = 1
  AND EXISTS (
      SELECT 1
      FROM room_members AS rm
      WHERE rm.room_id = $roomId
        AND rm.member_id = $actorMemberId
        AND rm.role = 'admin'
        AND rm.active = 1
  )
RETURNING
    id,
    provider,
    external_chat_id,
    title,
    avatar_url,
    timezone,
    plurnk_workspace,
    join_code,
    active;

-- PREP: upsertRoomMember
INSERT INTO room_members (
    room_id,
    member_id,
    role,
    active,
    verified_at
)
VALUES (
    $roomId,
    $memberId,
    $role,
    $active,
    $verifiedAt
)
ON CONFLICT(room_id, member_id) DO UPDATE SET
    role = excluded.role,
    active = excluded.active,
    verified_at = excluded.verified_at,
    updated_at = datetime('now');

-- PREP: demoteAbsentRoomAdmins
UPDATE room_members
SET role = 'member',
    updated_at = datetime('now')
WHERE room_id = $roomId
  AND role = 'admin'
  AND member_id NOT IN (
      SELECT CAST(value AS INTEGER)
      FROM json_each($adminMemberIdsJson)
  );

-- PREP: listMemberRooms
SELECT
    r.id,
    r.provider,
    r.external_chat_id,
    r.title,
    r.avatar_url,
    r.timezone,
    r.plurnk_workspace,
    r.join_code,
    rm.role,
    rm.verified_at
FROM room_members AS rm
JOIN rooms AS r
  ON r.id = rm.room_id
WHERE rm.member_id = $memberId
  AND rm.active = 1
  AND r.active = 1
ORDER BY r.title COLLATE NOCASE, r.id;

-- PREP: getMemberRoom
SELECT
    r.id,
    r.provider,
    r.external_chat_id,
    r.title,
    r.avatar_url,
    r.timezone,
    r.plurnk_workspace,
    r.join_code,
    rm.role,
    rm.verified_at
FROM room_members AS rm
JOIN rooms AS r
  ON r.id = rm.room_id
WHERE r.id = $roomId
  AND r.active = 1
  AND rm.member_id = $memberId
  AND rm.active = 1;

-- PREP: listRoomMembers
SELECT
    m.id,
    m.provider,
    m.external_subject,
    m.username,
    m.display_name,
    m.avatar_url,
    m.is_agent,
    rm.role
FROM room_members AS rm
JOIN members AS m
  ON m.id = rm.member_id
WHERE rm.room_id = $roomId
  AND rm.active = 1
  AND EXISTS (
      SELECT 1
      FROM room_members AS actor
      WHERE actor.room_id = $roomId
        AND actor.member_id = $actorMemberId
        AND actor.active = 1
  )
ORDER BY
    CASE rm.role WHEN 'admin' THEN 0 ELSE 1 END,
    m.display_name COLLATE NOCASE,
    m.id;
