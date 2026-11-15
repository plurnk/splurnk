-- MIGRATE: 2 roomEnrollment
ALTER TABLE rooms ADD COLUMN join_code TEXT CHECK (
    join_code IS NULL
    OR (
        length(trim(join_code)) BETWEEN 22 AND 128
        AND join_code = trim(join_code)
    )
);

CREATE UNIQUE INDEX rooms_join_code
ON rooms(join_code)
WHERE join_code IS NOT NULL;

ALTER TABLE room_members ADD COLUMN verified_at INTEGER NOT NULL DEFAULT 0;
