-- PREP: createSession
INSERT INTO sessions (
    sid_hash,
    member_id,
    csrf_token,
    expires_at
)
VALUES (
    $sidHash,
    $memberId,
    $csrfToken,
    $expiresAt
);

-- PREP: getAuthenticatedSession
SELECT
    s.sid_hash,
    s.csrf_token,
    s.expires_at,
    m.id AS member_id,
    m.provider,
    m.external_subject,
    m.username,
    m.display_name,
    m.avatar_url,
    m.is_agent
FROM sessions AS s
JOIN members AS m
  ON m.id = s.member_id
WHERE s.sid_hash = $sidHash
  AND s.expires_at > $now;

-- PREP: touchSession
UPDATE sessions
SET last_seen = datetime('now')
WHERE sid_hash = $sidHash
  AND expires_at > $now;

-- PREP: destroySession
DELETE FROM sessions
WHERE sid_hash = $sidHash;

-- PREP: clearExpiredSessions
DELETE FROM sessions
WHERE expires_at <= $now;
