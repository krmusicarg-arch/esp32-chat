BEGIN;

ALTER TABLE family_assistant.reminders
  ADD COLUMN IF NOT EXISTS recurrence_rule text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS recurrence_timezone text NOT NULL DEFAULT 'America/Argentina/Cordoba';

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'family_assistant.reminders'::regclass
      AND conname = 'reminders_recurrence_rule_check'
  ) THEN
    ALTER TABLE family_assistant.reminders
      ADD CONSTRAINT reminders_recurrence_rule_check
      CHECK (recurrence_rule IN ('none', 'weekly'));
  END IF;
END;
$migration$;

UPDATE family_assistant.reminders r
SET recurrence_timezone = COALESCE(
  (SELECT fs.timezone FROM family_assistant.family_settings fs WHERE fs.id = 1),
  'America/Argentina/Cordoba'
)
WHERE r.recurrence_timezone = 'America/Argentina/Cordoba';

CREATE OR REPLACE FUNCTION family_assistant.create_family_reminder(
  p_task_id uuid,
  p_title text,
  p_description text,
  p_scheduled_at timestamptz,
  p_created_by uuid,
  p_metadata jsonb,
  p_recurrence_rule text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_reminder_id uuid;
  v_expected_members integer;
  v_active_members integer;
  v_first_member_id uuid;
  v_idempotency_seed text;
  v_timezone text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_created_by AND active = true
  ) THEN
    RAISE EXCEPTION 'active family member required';
  END IF;
  IF length(trim(COALESCE(p_title, ''))) = 0 OR p_scheduled_at IS NULL THEN
    RAISE EXCEPTION 'valid reminder title and schedule are required';
  END IF;
  IF p_recurrence_rule IS NULL OR p_recurrence_rule NOT IN ('none', 'weekly') THEN
    RAISE EXCEPTION 'invalid reminder recurrence rule';
  END IF;

  SELECT expected_members, COALESCE(NULLIF(timezone, ''), 'America/Argentina/Cordoba')
  INTO v_expected_members, v_timezone
  FROM family_settings WHERE id = 1;
  SELECT count(*) INTO v_active_members
  FROM family_members WHERE active = true;
  IF v_expected_members IS DISTINCT FROM 4 OR v_active_members <> 4 THEN
    RAISE EXCEPTION 'exactly four active family members are required';
  END IF;
  SELECT id INTO v_first_member_id
  FROM family_members WHERE active = true ORDER BY id LIMIT 1;

  IF p_metadata ? 'source_message_id' AND p_metadata ? 'reminder_index' THEN
    v_idempotency_seed := (p_metadata->>'source_message_id')
      || ':' || (p_metadata->>'reminder_index');
    PERFORM pg_advisory_xact_lock(hashtext(v_idempotency_seed));
    SELECT reminder_id INTO v_reminder_id
    FROM notification_deliveries
    WHERE idempotency_key =
      v_idempotency_seed || ':' || v_first_member_id::text || ':esp32'
    LIMIT 1;
    IF FOUND THEN
      RETURN v_reminder_id;
    END IF;
  END IF;

  INSERT INTO reminders (
    task_id, title, description, scheduled_at, status, created_by,
    recurrence_rule, recurrence_timezone, metadata
  ) VALUES (
    p_task_id, trim(p_title), p_description, p_scheduled_at, 'pending',
    p_created_by, p_recurrence_rule, v_timezone, COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_reminder_id;

  INSERT INTO notification_deliveries (
    reminder_id, member_id, channel, delivery_status, idempotency_key, attempts
  )
  SELECT v_reminder_id, id, 'esp32', 'pending',
         COALESCE(v_idempotency_seed, v_reminder_id::text)
           || ':' || id::text || ':esp32', 0
  FROM family_members
  WHERE active = true
  ON CONFLICT DO NOTHING;

  RETURN v_reminder_id;
END;
$function$;

-- Keep existing task and follow-up callers working as one-time reminders.
CREATE OR REPLACE FUNCTION family_assistant.create_family_reminder(
  p_task_id uuid,
  p_title text,
  p_description text,
  p_scheduled_at timestamptz,
  p_created_by uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
BEGIN
  RETURN family_assistant.create_family_reminder(
    p_task_id, p_title, p_description, p_scheduled_at, p_created_by,
    p_metadata, 'none'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION family_assistant.claim_due_notifications(
  p_member_id uuid,
  p_limit integer DEFAULT 5
)
RETURNS TABLE (
  delivery_id uuid,
  reminder_id uuid,
  title text,
  description text,
  scheduled_at timestamptz,
  metadata jsonb,
  attempts smallint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_settings family_settings%ROWTYPE;
  v_local_time time;
  v_day_start timestamptz;
  v_count integer;
  v_delivery record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_member_id AND active = true
  ) THEN
    RAISE EXCEPTION 'active family member required';
  END IF;
  PERFORM family_assistant.enqueue_due_followups(25);
  SELECT * INTO v_settings FROM family_settings WHERE id = 1 FOR UPDATE;
  IF NOT FOUND OR NOT v_settings.proactive_enabled
      OR v_settings.max_proactive_messages_per_day = 0 THEN
    RETURN;
  END IF;
  UPDATE notification_deliveries d
  SET delivery_status = 'failed',
      last_error = COALESCE(d.last_error, 'notification claim expired after final attempt')
  WHERE d.member_id = p_member_id
    AND d.delivery_status = 'processing'
    AND d.attempts >= 5
    AND d.updated_at <= now() - interval '5 minutes';
  v_local_time := (now() AT TIME ZONE v_settings.timezone)::time;
  IF v_settings.quiet_hours_start IS NOT NULL
      AND v_settings.quiet_hours_end IS NOT NULL
      AND (
        (v_settings.quiet_hours_start <= v_settings.quiet_hours_end
          AND v_local_time >= v_settings.quiet_hours_start
          AND v_local_time < v_settings.quiet_hours_end)
        OR
        (v_settings.quiet_hours_start > v_settings.quiet_hours_end
          AND (v_local_time >= v_settings.quiet_hours_start
            OR v_local_time < v_settings.quiet_hours_end))
      ) THEN
    RETURN;
  END IF;
  v_day_start :=
    ((now() AT TIME ZONE v_settings.timezone)::date::timestamp
      AT TIME ZONE v_settings.timezone);

  FOR v_delivery IN
    SELECT d.id, d.reminder_id, r.title, r.description, r.scheduled_at,
           r.metadata, d.attempts
    FROM notification_deliveries d
    JOIN reminders r ON r.id = d.reminder_id
    WHERE d.member_id = p_member_id
      AND d.channel = 'esp32'
      AND (
        (d.delivery_status = 'pending'
          AND (d.last_error IS NULL OR d.updated_at <= now() -
            make_interval(secs => LEAST(30 * power(2, d.attempts::integer), 3600))))
        OR (d.delivery_status = 'processing'
          AND d.updated_at <= now() - interval '5 minutes')
      )
      AND r.status = 'pending'
      AND r.scheduled_at <= now()
      AND d.attempts < 5
    ORDER BY r.scheduled_at, d.created_at
    LIMIT LEAST(GREATEST(p_limit, 1), 20)
    FOR UPDATE OF d SKIP LOCKED
  LOOP
    SELECT count(*) INTO v_count
    FROM notification_deliveries
    WHERE member_id = p_member_id
      AND (
        (delivery_status IN ('sent', 'pending') AND sent_at >= v_day_start)
        OR (delivery_status = 'processing' AND updated_at >= v_day_start)
      );
    EXIT WHEN v_count >= v_settings.max_proactive_messages_per_day;

    UPDATE notification_deliveries d
    SET delivery_status = 'processing',
        attempts = d.attempts + 1,
        last_error = NULL
    WHERE d.id = v_delivery.id;
    delivery_id := v_delivery.id;
    reminder_id := v_delivery.reminder_id;
    title := v_delivery.title;
    description := v_delivery.description;
    scheduled_at := v_delivery.scheduled_at;
    metadata := v_delivery.metadata;
    attempts := v_delivery.attempts + 1;
    RETURN NEXT;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION family_assistant.ack_notification_delivery(
  p_delivery_id uuid,
  p_member_id uuid,
  p_success boolean,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_reminder_id uuid;
  v_recurrence_rule text;
  v_recurrence_timezone text;
  v_scheduled_at timestamptz;
  v_next_scheduled_at timestamptz;
  v_local_scheduled_at timestamp without time zone;
  v_reminder_active boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_member_id AND active = true
  ) THEN
    RAISE EXCEPTION 'active family member required';
  END IF;

  UPDATE notification_deliveries
  SET delivery_status = CASE
        WHEN p_success THEN 'sent'
        WHEN attempts >= 5 THEN 'failed'
        ELSE 'pending'
      END,
      sent_at = CASE WHEN p_success THEN now() ELSE NULL END,
      last_error = CASE WHEN p_success THEN NULL ELSE left(COALESCE(p_error, 'delivery failed'), 500) END
  WHERE id = p_delivery_id
    AND member_id = p_member_id
    AND delivery_status = 'processing'
  RETURNING reminder_id INTO v_reminder_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_success AND NOT EXISTS (
    SELECT 1 FROM notification_deliveries
    WHERE reminder_id = v_reminder_id
      AND delivery_status NOT IN ('sent', 'cancelled')
  ) THEN
    SELECT recurrence_rule, recurrence_timezone, scheduled_at
    INTO v_recurrence_rule, v_recurrence_timezone, v_scheduled_at
    FROM reminders
    WHERE id = v_reminder_id AND status = 'pending'
    FOR UPDATE;
    v_reminder_active := FOUND;

    IF v_reminder_active AND v_recurrence_rule = 'weekly' THEN
      v_local_scheduled_at := v_scheduled_at AT TIME ZONE v_recurrence_timezone;
      v_next_scheduled_at := (v_local_scheduled_at + interval '7 days')
        AT TIME ZONE v_recurrence_timezone;
      WHILE v_next_scheduled_at <= now() LOOP
        v_local_scheduled_at := v_local_scheduled_at + interval '7 days';
        v_next_scheduled_at := v_local_scheduled_at AT TIME ZONE v_recurrence_timezone;
      END LOOP;

      UPDATE reminders
      SET scheduled_at = v_next_scheduled_at
      WHERE id = v_reminder_id AND status = 'pending';

      UPDATE notification_deliveries
      SET delivery_status = 'pending',
          attempts = 0,
          last_error = NULL,
          sent_at = now(),
          updated_at = now()
      WHERE reminder_id = v_reminder_id AND delivery_status = 'sent';
    ELSIF v_reminder_active THEN
      UPDATE reminders SET status = 'sent'
      WHERE id = v_reminder_id AND status = 'pending';
    END IF;
  END IF;
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION family_assistant.create_family_reminder(uuid, text, text, timestamptz, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION family_assistant.create_family_reminder(uuid, text, text, timestamptz, uuid, jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION family_assistant.ack_notification_delivery(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION family_assistant.ack_notification_delivery(uuid, uuid, boolean, text) TO service_role;

COMMIT;
