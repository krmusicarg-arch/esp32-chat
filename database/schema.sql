create extension if not exists pgcrypto;

create table if not exists assistant_families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references assistant_families(id) on delete cascade,
  display_name text not null,
  role text not null default 'member',
  created_at timestamptz not null default now()
);

create table if not exists assistant_devices (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  family_member_id uuid not null references family_members(id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references assistant_families(id) on delete cascade,
  member_id uuid not null references family_members(id) on delete cascade,
  question text not null,
  answer text not null,
  searched_web boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists assistant_conversations_member_recent
  on assistant_conversations (member_id, created_at desc);

create table if not exists assistant_memories (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references assistant_families(id) on delete cascade,
  member_id uuid not null references family_members(id) on delete cascade,
  content text not null,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  unique (family_id, member_id, fingerprint)
);

create index if not exists assistant_memories_family_recent
  on assistant_memories (family_id, created_at desc);

create table if not exists assistant_tasks (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references assistant_families(id) on delete cascade,
  member_id uuid not null references family_members(id) on delete cascade,
  title text not null,
  description text not null default '',
  kind text not null default 'task' check (kind in ('task', 'project')),
  status text not null default 'open' check (status in ('open', 'completed')),
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assistant_tasks_family_status
  on assistant_tasks (family_id, status, updated_at desc);

create table if not exists assistant_reminders (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references assistant_families(id) on delete cascade,
  member_id uuid not null references family_members(id) on delete cascade,
  title text not null,
  remind_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'completed')),
  created_at timestamptz not null default now()
);

create index if not exists assistant_reminders_family_active
  on assistant_reminders (family_id, status, remind_at);

alter table assistant_families enable row level security;
alter table family_members enable row level security;
alter table assistant_devices enable row level security;
alter table assistant_conversations enable row level security;
alter table assistant_memories enable row level security;
alter table assistant_tasks enable row level security;
alter table assistant_reminders enable row level security;

revoke all on assistant_families, family_members, assistant_devices,
  assistant_conversations, assistant_memories, assistant_tasks,
  assistant_reminders from anon, authenticated;
grant all on assistant_families, family_members, assistant_devices,
  assistant_conversations, assistant_memories, assistant_tasks,
  assistant_reminders to service_role;
