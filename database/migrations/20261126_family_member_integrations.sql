begin;

create table if not exists family_assistant.family_member_integrations (
  id uuid primary key default gen_random_uuid(),
  family_member_id uuid not null
    references family_assistant.family_members(id) on delete cascade,
  provider text not null check (provider = 'google_calendar'),
  composio_user_id text not null check (length(btrim(composio_user_id)) > 0),
  connected_account_id text not null check (connected_account_id ~ '^ca_[A-Za-z0-9_-]+$'),
  calendar_id text not null default 'primary' check (length(btrim(calendar_id)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint family_member_integrations_member_provider_key
    unique (family_member_id, provider)
);

create index if not exists family_member_integrations_active_lookup
  on family_assistant.family_member_integrations (family_member_id, provider)
  where active = true;

alter table family_assistant.family_member_integrations enable row level security;
revoke all on family_assistant.family_member_integrations from public, anon, authenticated;
grant usage on schema family_assistant to service_role;
grant select on family_assistant.family_member_integrations to service_role;

commit;
