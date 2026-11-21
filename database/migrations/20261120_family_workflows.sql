BEGIN;

CREATE OR REPLACE FUNCTION family_assistant.save_family_memory(
  p_memory_id uuid,
  p_subject_member_id uuid,
  p_category text,
  p_content text,
  p_importance smallint,
  p_confidence numeric,
  p_source_message_id uuid,
  p_changed_by uuid,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_memory_id uuid;
  v_previous_content text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_changed_by AND active = true
  ) THEN
    RAISE EXCEPTION 'active family member required';
  END IF;
  IF p_subject_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_subject_member_id AND active = true
  ) THEN
    RAISE EXCEPTION 'subject must be an active family member';
  END IF;
  IF p_category IS NULL OR p_category NOT IN (
    'IDENTITY', 'LIKES', 'PREFERENCES', 'FAMILY', 'EXPERIENCES',
    'GOALS', 'ROUTINES', 'IMPORTANT_EVENTS', 'EMOTIONAL_CONTEXT'
  ) OR p_importance IS NULL OR p_importance NOT BETWEEN 1 AND 5
    OR p_confidence IS NULL OR p_confidence NOT BETWEEN 0 AND 1
    OR length(trim(COALESCE(p_content, ''))) = 0 THEN
    RAISE EXCEPTION 'invalid family memory';
  END IF;

  IF p_memory_id IS NULL AND p_source_message_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(
      p_source_message_id::text || ':' || p_category || ':' || COALESCE(p_content, '')
    ));
    SELECT id INTO v_memory_id
    FROM memories
    WHERE source_message_id = p_source_message_id
      AND subject_member_id IS NOT DISTINCT FROM p_subject_member_id
      AND category = p_category
      AND content = p_content
      AND metadata->>'provided_by_member_id' = p_changed_by::text
    LIMIT 1;
    IF FOUND THEN
      RETURN v_memory_id;
    END IF;
  END IF;

  IF p_memory_id IS NOT NULL THEN
    SELECT content INTO v_previous_content
    FROM memories
    WHERE id = p_memory_id AND active = true
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active memory not found';
    END IF;
    v_memory_id := p_memory_id;
    IF v_previous_content IS DISTINCT FROM p_content THEN
      INSERT INTO memory_versions (
        memory_id, previous_content, new_content, changed_by, reason
      ) VALUES (
        v_memory_id, v_previous_content, p_content, p_changed_by,
        NULLIF(trim(p_reason), '')
      );
    END IF;
    UPDATE memories
    SET subject_member_id = p_subject_member_id,
        category = p_category,
        content = p_content,
        importance = p_importance,
        confidence = p_confidence,
        source_message_id = p_source_message_id,
        valid_from = now(),
        valid_until = NULL,
        active = true,
        metadata = metadata || jsonb_build_object(
          'provided_by_member_id', p_changed_by
        )
    WHERE id = v_memory_id;
  ELSE
    INSERT INTO memories (
      subject_member_id, category, content, importance, confidence,
      source_message_id, metadata
    ) VALUES (
      p_subject_member_id, p_category, p_content, p_importance, p_confidence,
      p_source_message_id,
      jsonb_build_object('provided_by_member_id', p_changed_by)
    )
    RETURNING id INTO v_memory_id;
  END IF;
  RETURN v_memory_id;
END;
$function$;

CREATE OR REPLACE FUNCTION family_assistant.save_family_followup(
  p_member_id uuid,
  p_memory_id uuid,
  p_question text,
  p_scheduled_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_followup_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_member_id AND active = true
  ) THEN
    RAISE EXCEPTION 'active family member required';
  END IF;
  IF p_memory_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM memories
    WHERE id = p_memory_id AND active = true
  ) THEN
    RAISE EXCEPTION 'active memory required';
  END IF;
  IF length(trim(COALESCE(p_question, ''))) = 0
      OR length(trim(p_question)) > 200
      OR p_scheduled_at IS NULL
      OR p_scheduled_at <= now() THEN
    RAISE EXCEPTION 'valid future follow-up required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(
    p_member_id::text || ':followup:' || lower(trim(p_question))
  ));
  SELECT id INTO v_followup_id
  FROM proactive_followups
  WHERE member_id = p_member_id
    AND lower(trim(question)) = lower(trim(p_question))
    AND status IN ('pending', 'sent')
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    RETURN v_followup_id;
  END IF;

  INSERT INTO proactive_followups (
    member_id, memory_id, question, scheduled_at, status
  ) VALUES (
    p_member_id, p_memory_id, trim(p_question), p_scheduled_at, 'pending'
  )
  RETURNING id INTO v_followup_id;
  RETURN v_followup_id;
END;
$function$;

CREATE OR REPLACE FUNCTION family_assistant.save_family_preference(
  p_member_id uuid,
  p_category text,
  p_value jsonb,
  p_confidence numeric,
  p_source_message_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_preference_id uuid;
  v_existing_value jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_member_id AND active = true
  ) THEN
    RAISE EXCEPTION 'active family member required';
  END IF;
  IF length(trim(COALESCE(p_category, ''))) = 0
      OR length(trim(p_category)) > 80
      OR p_value IS NULL
      OR p_confidence IS NULL
      OR p_confidence NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'invalid family preference';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(
    p_member_id::text || ':preference:' || lower(trim(p_category))
  ));
  SELECT id, value INTO v_preference_id, v_existing_value
  FROM preferences
  WHERE member_id = p_member_id
    AND lower(trim(category)) = lower(trim(p_category))
    AND active = true
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND v_existing_value = p_value THEN
    UPDATE preferences
    SET confidence = p_confidence,
        source_message_id = p_source_message_id
    WHERE id = v_preference_id;
    RETURN v_preference_id;
  END IF;

  UPDATE preferences
  SET active = false
  WHERE member_id = p_member_id
    AND lower(trim(category)) = lower(trim(p_category))
    AND active = true;

  INSERT INTO preferences (
    member_id, category, value, confidence, source_message_id, active
  ) VALUES (
    p_member_id, trim(p_category), p_value, p_confidence,
    p_source_message_id, true
  )
  RETURNING id INTO v_preference_id;
  RETURN v_preference_id;
END;
$function$;

CREATE OR REPLACE FUNCTION family_assistant.save_family_emotional_context(
  p_member_id uuid,
  p_situation text,
  p_context text,
  p_source_message_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_context_id uuid;
  v_existing_context text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_member_id AND active = true
  ) THEN
    RAISE EXCEPTION 'active family member required';
  END IF;
  IF length(trim(COALESCE(p_situation, ''))) = 0
      OR length(trim(p_situation)) > 160
      OR length(trim(COALESCE(p_context, ''))) = 0
      OR length(trim(p_context)) > 300 THEN
    RAISE EXCEPTION 'invalid emotional context';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(
    p_member_id::text || ':emotional:' || lower(trim(p_situation))
  ));
  SELECT id, context INTO v_context_id, v_existing_context
  FROM emotional_context
  WHERE member_id = p_member_id
    AND lower(trim(situation)) = lower(trim(p_situation))
    AND status = 'active'
  ORDER BY last_update DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_context IS DISTINCT FROM trim(p_context) THEN
      UPDATE emotional_context
      SET context = trim(p_context),
          source_message_id = p_source_message_id,
          last_update = now()
      WHERE id = v_context_id;
    END IF;
    RETURN v_context_id;
  END IF;

  INSERT INTO emotional_context (
    member_id, situation, context, status, source_message_id
  ) VALUES (
    p_member_id, trim(p_situation), trim(p_context), 'active',
    p_source_message_id
  )
  RETURNING id INTO v_context_id;
  RETURN v_context_id;
END;
$function$;

CREATE OR REPLACE FUNCTION family_assistant.create_family_task(
  p_description text,
  p_created_by uuid,
  p_assigned_to uuid,
  p_due_at timestamptz,
  p_source_message_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_task_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_created_by AND active = true
  ) OR (p_assigned_to IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_assigned_to AND active = true
  )) THEN
    RAISE EXCEPTION 'active task members required';
  END IF;
  IF length(trim(COALESCE(p_description, ''))) = 0 THEN
    RAISE EXCEPTION 'task description is required';
  END IF;

  IF p_source_message_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(
      p_source_message_id::text || ':task:' || trim(p_description)
    ));
    SELECT id INTO v_task_id
    FROM tasks
    WHERE created_by = p_created_by
      AND metadata->>'source_message_id' = p_source_message_id::text
      AND description = trim(p_description)
    LIMIT 1;
    IF FOUND THEN
      RETURN v_task_id;
    END IF;
  END IF;

  INSERT INTO tasks (
    description, status, created_by, assigned_to, due_at, metadata
  ) VALUES (
    trim(p_description), 'pending', p_created_by, p_assigned_to, p_due_at,
    jsonb_build_object('origin', 'assistant', 'source_message_id', p_source_message_id)
  )
  RETURNING id INTO v_task_id;

  IF p_due_at IS NOT NULL THEN
    PERFORM family_assistant.create_family_reminder(
      v_task_id,
      'Tarea pendiente',
      trim(p_description),
      p_due_at,
      p_created_by,
      jsonb_build_object(
        'origin', 'task_due',
        'source_message_id', p_source_message_id,
        'reminder_index', 'task_due:' || v_task_id::text
      )
    );
  END IF;
  RETURN v_task_id;
END;
$function$;

CREATE OR REPLACE FUNCTION family_assistant.save_family_project(
  p_project_id uuid,
  p_name text,
  p_description text,
  p_next_step text,
  p_owner_member_id uuid,
  p_source_message_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_project_id uuid;
BEGIN
  IF p_owner_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_owner_member_id AND active = true
  ) THEN
    RAISE EXCEPTION 'project owner must be an active family member';
  END IF;
  IF length(trim(COALESCE(p_name, ''))) = 0 THEN
    RAISE EXCEPTION 'project name is required';
  END IF;
  IF p_project_id IS NOT NULL THEN
    UPDATE projects
    SET name = trim(p_name),
        description = p_description,
        next_step = p_next_step,
        owner_member_id = p_owner_member_id,
        metadata = metadata || jsonb_build_object(
          'last_updated_by_message_id', p_source_message_id
        )
    WHERE id = p_project_id
    RETURNING id INTO v_project_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active project not found';
    END IF;
    RETURN v_project_id;
  END IF;
  IF p_source_message_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(
      p_source_message_id::text || ':project:' || trim(p_name)
    ));
    SELECT id INTO v_project_id
    FROM projects
    WHERE metadata->>'source_message_id' = p_source_message_id::text
      AND name = trim(p_name)
    LIMIT 1;
    IF FOUND THEN
      RETURN v_project_id;
    END IF;
  END IF;
  INSERT INTO projects (
    owner_member_id, name, description, status, next_step, metadata
  ) VALUES (
    p_owner_member_id, trim(p_name), p_description, 'active', p_next_step,
    jsonb_build_object('origin', 'assistant', 'source_message_id', p_source_message_id)
  )
  RETURNING id INTO v_project_id;
  RETURN v_project_id;
END;
$function$;

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
DECLARE
  v_reminder_id uuid;
  v_expected_members integer;
  v_active_members integer;
  v_first_member_id uuid;
  v_idempotency_seed text;
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
  SELECT expected_members INTO v_expected_members
  FROM family_settings WHERE id = 1;
  SELECT count(*) INTO v_active_members
  FROM family_members WHERE active = true;
  IF v_expected_members IS DISTINCT FROM 4 OR v_active_members <> 4 THEN
    RAISE EXCEPTION 'exactly four active family members are required';
  END IF;
  SELECT id INTO v_first_member_id
  FROM family_members WHERE active = true ORDER BY id LIMIT 1;

  IF p_metadata ? 'source_message_id' AND p_metadata ? 'reminder_index' THEN
    v_idempotency_seed := p_metadata->>'source_message_id'
      || ':' || p_metadata->>'reminder_index';
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
    task_id, title, description, scheduled_at, status, created_by, metadata
  ) VALUES (
    p_task_id, trim(p_title), p_description, p_scheduled_at, 'pending',
    p_created_by, COALESCE(p_metadata, '{}'::jsonb)
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

CREATE OR REPLACE FUNCTION family_assistant.transition_family_task(
  p_task_id uuid,
  p_member_id uuid,
  p_new_status text,
  p_detail text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_task tasks%ROWTYPE;
  v_event text;
  v_reminder_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_member_id AND active = true
  ) THEN
    RAISE EXCEPTION 'active family member required';
  END IF;
  IF p_new_status IS NULL
      OR p_new_status NOT IN ('pending', 'in_progress', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'invalid task status';
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task not found';
  END IF;
  IF v_task.status = p_new_status THEN
    RETURN jsonb_build_object('task_id', p_task_id, 'changed', false);
  END IF;

  UPDATE notification_deliveries d
  SET delivery_status = 'cancelled', last_error = NULL
  FROM reminders r
  WHERE r.id = d.reminder_id
    AND r.task_id = p_task_id
    AND r.metadata->>'event' LIKE 'task_%'
    AND r.status IN ('pending', 'processing')
    AND d.delivery_status IN ('pending', 'processing');
  UPDATE reminders
  SET status = 'cancelled'
  WHERE task_id = p_task_id
    AND metadata->>'event' LIKE 'task_%'
    AND status IN ('pending', 'processing');

  UPDATE tasks
  SET status = p_new_status,
      completed_by = CASE WHEN p_new_status = 'completed' THEN p_member_id ELSE NULL END,
      completed_at = CASE WHEN p_new_status = 'completed' THEN now() ELSE NULL END
  WHERE id = p_task_id;

  INSERT INTO task_history (
    task_id, member_id, previous_status, new_status, detail
  ) VALUES (
    p_task_id, p_member_id, v_task.status, p_new_status, p_detail
  );

  IF p_new_status IN ('completed', 'cancelled') THEN
    UPDATE notification_deliveries d
    SET delivery_status = 'cancelled', last_error = NULL
    FROM reminders r
    WHERE r.id = d.reminder_id
      AND r.task_id = p_task_id
      AND r.metadata->>'event' IS NULL
      AND d.delivery_status IN ('pending', 'processing');
    UPDATE reminders
    SET status = 'cancelled'
    WHERE task_id = p_task_id
      AND metadata->>'event' IS NULL
      AND status IN ('pending', 'processing');
  ELSIF p_new_status IN ('pending', 'in_progress')
      AND v_task.status IN ('completed', 'cancelled') THEN
    UPDATE reminders
    SET status = 'pending'
    WHERE task_id = p_task_id
      AND metadata->>'event' IS NULL
      AND status = 'cancelled'
      AND scheduled_at > now();
    UPDATE notification_deliveries d
    SET delivery_status = 'pending', last_error = NULL, sent_at = NULL
    FROM reminders r
    WHERE r.id = d.reminder_id
      AND r.task_id = p_task_id
      AND r.metadata->>'event' IS NULL
      AND r.status = 'pending'
      AND d.delivery_status = 'cancelled';
  END IF;

  IF p_new_status = 'completed' THEN
    v_event := 'task_completed';
  ELSIF p_new_status IN ('pending', 'in_progress')
      AND v_task.status IN ('completed', 'cancelled') THEN
    v_event := 'task_reopened';
  ELSE
    v_event := NULL;
  END IF;

  IF v_event IS NOT NULL THEN
    v_reminder_id := family_assistant.create_family_reminder(
      p_task_id,
      CASE WHEN v_event = 'task_completed' THEN 'Tarea completada'
        ELSE 'Tarea reabierta' END,
      v_task.description,
      now(),
      p_member_id,
      jsonb_build_object('event', v_event)
    );
  END IF;

  RETURN jsonb_build_object(
    'task_id', p_task_id,
    'previous_status', v_task.status,
    'status', p_new_status,
    'changed', true
  );
END;
$function$;

CREATE OR REPLACE FUNCTION family_assistant.transition_family_followup(
  p_followup_id uuid,
  p_member_id uuid,
  p_new_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_status text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_member_id AND active = true
  ) THEN
    RAISE EXCEPTION 'active family member required';
  END IF;
  IF p_new_status IS NULL OR p_new_status NOT IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'invalid follow-up status';
  END IF;

  SELECT status INTO v_status
  FROM proactive_followups
  WHERE id = p_followup_id AND member_id = p_member_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_status = p_new_status THEN
    RETURN true;
  END IF;
  IF v_status NOT IN ('pending', 'sent') THEN
    RETURN false;
  END IF;

  UPDATE notification_deliveries d
  SET delivery_status = 'cancelled',
      last_error = NULL
  FROM reminders r
  WHERE r.id = d.reminder_id
    AND r.metadata->>'followup_id' = p_followup_id::text
    AND r.status IN ('pending', 'processing')
    AND d.delivery_status IN ('pending', 'processing');
  UPDATE reminders
  SET status = 'cancelled'
  WHERE metadata->>'followup_id' = p_followup_id::text
    AND status IN ('pending', 'processing');
  UPDATE proactive_followups
  SET status = p_new_status
  WHERE id = p_followup_id;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION family_assistant.cancel_family_reminder(
  p_reminder_id uuid,
  p_member_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_updated integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE id = p_member_id AND active = true
  ) THEN
    RAISE EXCEPTION 'active family member required';
  END IF;

  UPDATE reminders
  SET status = 'cancelled'
  WHERE id = p_reminder_id AND status IN ('pending', 'processing');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN false;
  END IF;
  UPDATE notification_deliveries
  SET delivery_status = 'cancelled', last_error = NULL
  WHERE reminder_id = p_reminder_id
    AND delivery_status IN ('pending', 'processing');
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION family_assistant.enqueue_due_followups(
  p_limit integer DEFAULT 25
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = family_assistant, pg_temp
AS $function$
DECLARE
  v_followup proactive_followups%ROWTYPE;
  v_member_id uuid;
  v_count integer := 0;
BEGIN
  FOR v_followup IN
    SELECT * FROM proactive_followups
    WHERE status = 'pending'
      AND scheduled_at IS NOT NULL
      AND scheduled_at <= now()
    ORDER BY scheduled_at
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT id INTO v_member_id
    FROM family_members
    WHERE active = true
      AND (v_followup.member_id IS NULL OR id = v_followup.member_id)
    ORDER BY created_at
    LIMIT 1;
    IF v_member_id IS NULL THEN
      CONTINUE;
    END IF;
    PERFORM family_assistant.create_family_reminder(
      NULL,
      'Seguimiento familiar',
      v_followup.question,
      now(),
      v_member_id,
      jsonb_build_object(
        'event', 'proactive_followup',
        'followup_id', v_followup.id,
        'memory_id', v_followup.memory_id
      )
    );
    UPDATE proactive_followups SET status = 'sent' WHERE id = v_followup.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
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
        (delivery_status = 'sent' AND sent_at >= v_day_start)
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
  v_attempts smallint;
  v_status text;
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
  RETURNING reminder_id, attempts, delivery_status
  INTO v_reminder_id, v_attempts, v_status;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_success AND NOT EXISTS (
    SELECT 1 FROM notification_deliveries
    WHERE reminder_id = v_reminder_id
      AND delivery_status NOT IN ('sent', 'cancelled')
  ) THEN
    UPDATE reminders SET status = 'sent'
    WHERE id = v_reminder_id AND status = 'pending';
  END IF;
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION family_assistant.save_family_memory(uuid, uuid, text, text, smallint, numeric, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION family_assistant.save_family_followup(uuid, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION family_assistant.save_family_preference(uuid, text, jsonb, numeric, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION family_assistant.save_family_emotional_context(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION family_assistant.create_family_task(text, uuid, uuid, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION family_assistant.save_family_project(uuid, text, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION family_assistant.create_family_reminder(uuid, text, text, timestamptz, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION family_assistant.transition_family_task(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION family_assistant.transition_family_followup(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION family_assistant.cancel_family_reminder(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION family_assistant.enqueue_due_followups(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION family_assistant.claim_due_notifications(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION family_assistant.ack_notification_delivery(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION family_assistant.save_family_memory(uuid, uuid, text, text, smallint, numeric, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION family_assistant.save_family_followup(uuid, uuid, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION family_assistant.save_family_preference(uuid, text, jsonb, numeric, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION family_assistant.save_family_emotional_context(uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION family_assistant.create_family_task(text, uuid, uuid, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION family_assistant.save_family_project(uuid, text, text, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION family_assistant.create_family_reminder(uuid, text, text, timestamptz, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION family_assistant.transition_family_task(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION family_assistant.transition_family_followup(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION family_assistant.cancel_family_reminder(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION family_assistant.enqueue_due_followups(integer) TO service_role;
GRANT EXECUTE ON FUNCTION family_assistant.claim_due_notifications(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION family_assistant.ack_notification_delivery(uuid, uuid, boolean, text) TO service_role;

GRANT USAGE ON SCHEMA family_assistant TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA family_assistant TO service_role;
GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA family_assistant TO service_role;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a
      ON a.attrelid = i.indrelid AND a.attname = 'idempotency_key'
    WHERE i.indrelid = 'family_assistant.notification_deliveries'::regclass
      AND i.indisunique
      AND i.indisvalid
      AND i.indpred IS NULL
      AND i.indnkeyatts = 1
      AND i.indnatts = 1
      AND i.indkey::text = a.attnum::text
  ) THEN
    IF EXISTS (
      SELECT idempotency_key
      FROM family_assistant.notification_deliveries
      WHERE idempotency_key IS NOT NULL
      GROUP BY idempotency_key
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION
        'duplicate notification idempotency keys must be reviewed before migration';
    END IF;

    CREATE UNIQUE INDEX IF NOT EXISTS
      notification_deliveries_idempotency_key_uidx
      ON family_assistant.notification_deliveries (idempotency_key);
  END IF;
END;
$migration$;

COMMIT;
