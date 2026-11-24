-- Complementary migration for the existing family message tables.
-- Does not create, drop, or replace either table or the existing trigger.

alter table family_assistant.family_messages
  add column if not exists client_request_id uuid;

create unique index if not exists uq_family_messages_sender_request
  on family_assistant.family_messages (sender_id, client_request_id);

-- Keep the current trigger and replace only its function implementation.
-- Every active member except the sender gets an independent read receipt,
-- including messages addressed to a specific recipient.
create or replace function family_assistant.create_family_message_reads()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
begin
  if not exists (
    select 1 from family_assistant.family_members fm
    where fm.id = new.sender_id and fm.active = true
  ) then
    raise exception using errcode = '23503', message = 'Message sender must be an active family member';
  end if;

  if new.recipient_id is not null and not exists (
    select 1 from family_assistant.family_members fm
    where fm.id = new.recipient_id and fm.active = true
  ) then
    raise exception using errcode = '23503', message = 'Message recipient must be an active family member';
  end if;

  insert into family_assistant.family_message_reads (message_id, member_id)
  select new.id, fm.id
  from family_assistant.family_members fm
  where fm.active = true
    and fm.id <> new.sender_id
  on conflict (message_id, member_id) do nothing;

  return new;
end;
$function$;

-- Bring old messages in line with the individual receipt model. Existing rows
-- are kept; only missing receipt rows are added.
insert into family_assistant.family_message_reads (message_id, member_id)
select fm_msg.id, fm_member.id
from family_assistant.family_messages fm_msg
cross join family_assistant.family_members fm_member
where fm_member.active = true
  and fm_member.id <> fm_msg.sender_id
on conflict (message_id, member_id) do nothing;
