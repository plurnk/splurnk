-- PREP: upsertMember
INSERT INTO members (
    provider,
    external_subject,
    username,
    display_name,
    avatar_url,
    is_agent
)
VALUES (
    $provider,
    $externalSubject,
    $username,
    $displayName,
    $avatarUrl,
    $isAgent
)
ON CONFLICT(provider, external_subject) DO UPDATE SET
    username = excluded.username,
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    is_agent = excluded.is_agent,
    updated_at = datetime('now')
RETURNING
    id,
    provider,
    external_subject,
    username,
    display_name,
    avatar_url,
    is_agent;

-- PREP: getMemberById
SELECT
    id,
    provider,
    external_subject,
    username,
    display_name,
    avatar_url,
    is_agent
FROM members
WHERE id = $memberId;

-- PREP: getMemberBySubject
SELECT
    id,
    provider,
    external_subject,
    username,
    display_name,
    avatar_url,
    is_agent
FROM members
WHERE provider = $provider
  AND external_subject = $externalSubject;
