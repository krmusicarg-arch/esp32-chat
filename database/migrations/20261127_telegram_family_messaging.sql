-- Telegram additions to existing family tables. Additive and rerunnable.
-- Does not create family members or delete existing data.
BEGIN;

ALTER TABLE family_assistant.family_members
  ADD COLUMN IF NOT EXISTS telegram_user_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_private_chat_id bigint;

CREATE UNIQUE INDEX IF NOT EXISTS family_members_telegram_user_id_uidx
  ON family_assistant.family_members (telegram_user_id)
  WHERE telegram_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS family_members_telegram_private_chat_uidx
  ON family_assistant.family_members (telegram_private_chat_id)
  WHERE telegram_private_chat_id IS NOT NULL;

ALTER TABLE family_assistant.family_messages
  ADD COLUMN IF NOT EXISTS source_channel text NOT NULL DEFAULT 'pwa',
  ADD COLUMN IF NOT EXISTS telegram_chat_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_message_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_update_id bigint;

-- NULLs permit all existing non-Telegram rows; Telegram source IDs are unique.
CREATE UNIQUE INDEX IF NOT EXISTS family_messages_telegram_origin_uidx
  ON family_assistant.family_messages (telegram_chat_id, telegram_message_id);

CREATE UNIQUE INDEX IF NOT EXISTS messages_telegram_update_user_uidx
  ON family_assistant.messages ((metadata->>'telegram_update_id'))
  WHERE role = 'user' AND metadata ? 'telegram_update_id';

ALTER TABLE family_assistant.notification_deliveries
  ADD COLUMN IF NOT EXISTS family_message_id uuid;
-- Existing reminder rows retain reminder_id. Message rows use family_message_id.
ALTER TABLE family_assistant.notification_deliveries
  ALTER COLUMN reminder_id DROP NOT NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'family_assistant.notification_deliveries'::regclass
      AND conname = 'notification_deliveries_family_message_fk'
  ) THEN
    ALTER TABLE family_assistant.notification_deliveries
      ADD CONSTRAINT notification_deliveries_family_message_fk
      FOREIGN KEY (family_message_id)
      REFERENCES family_assistant.family_messages(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'family_assistant.notification_deliveries'::regclass
      AND conname = 'notification_deliveries_reminder_or_message_check'
  ) THEN
    ALTER TABLE family_assistant.notification_deliveries
      ADD CONSTRAINT notification_deliveries_reminder_or_message_check
      CHECK ((reminder_id IS NOT NULL) <> (family_message_id IS NOT NULL));
  END IF;
END;
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_family_message_member_channel_uidx
  ON family_assistant.notification_deliveries (family_message_id, member_id, channel);

-- Preserve every channel already represented in data and add Telegram. Replace
-- only check constraints that explicitly mention channel.
DO $migration$
DECLARE
  v_constraint record;
  v_channels text[];
  v_channel_list text;
BEGIN
  SELECT array_agg(DISTINCT channel) INTO v_channels
  FROM family_assistant.notification_deliveries WHERE channel IS NOT NULL;
  v_channels := array_append(COALESCE(v_channels, ARRAY[]::text[]), 'telegram');
  FOR v_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'family_assistant.notification_deliveries'::regclass
      AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%channel%'
  LOOP
    EXECUTE format(
      'ALTER TABLE family_assistant.notification_deliveries DROP CONSTRAINT %I',
      v_constraint.conname
    );
  END LOOP;
  SELECT string_agg(quote_literal(value), ',') INTO v_channel_list
  FROM (SELECT DISTINCT unnest(v_channels) AS value) channels;
  EXECUTE format(
    'ALTER TABLE family_assistant.notification_deliveries ADD CONSTRAINT notification_deliveries_channel_check CHECK (channel IN (%s)) NOT VALID',
    v_channel_list
  );
  ALTER TABLE family_assistant.notification_deliveries
    VALIDATE CONSTRAINT notification_deliveries_channel_check;
END;
$migration$;

ALTER TABLE family_assistant.family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_assistant.family_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_assistant.notification_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON family_assistant.family_members,
  family_assistant.family_messages,
  family_assistant.notification_deliveries FROM anon, authenticated;
GRANT USAGE ON SCHEMA family_assistant TO service_role;
GRANT SELECT, UPDATE ON family_assistant.family_members TO service_role;
GRANT SELECT, INSERT, UPDATE ON family_assistant.family_messages TO service_role;
GRANT SELECT, INSERT, UPDATE ON family_assistant.notification_deliveries TO service_role;

COMMIT;

-- After identifying the numeric Telegram IDs and matching them to existing
-- active members, set the explicit pairs (never resolve by display name):
-- UPDATE family_assistant.family_members
-- SET telegram_user_id = <telegram_user_id>
-- WHERE id = '<existing_family_member_uuid>' AND active = true;
-- The private chat ID is saved only after that user initiates a bot chat.
