begin;

alter table family_assistant.family_member_integrations
  drop constraint if exists family_member_integrations_provider_check;

alter table family_assistant.family_member_integrations
  add constraint family_member_integrations_provider_check
  check (provider in ('google_calendar', 'google_tasks'));

commit;
