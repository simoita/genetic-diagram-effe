-- ============================================================
-- Diagramma Cascata - Setup Supabase
-- Esegui questo script nel SQL Editor del tuo progetto Supabase.
-- È idempotente: puoi rieseguirlo senza errori.
-- ============================================================

-- 1) Tabelle -------------------------------------------------
create table if not exists public.diagrams (
  id uuid primary key,
  name text default 'Diagramma',
  state jsonb,
  updated_at timestamptz default now()
);

create table if not exists public.active_users (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  display_name text,
  updated_at timestamptz default now()
);

-- 2) Riga del diagramma condiviso ----------------------------
insert into public.diagrams (id, name, state)
values ('00000000-0000-0000-0000-000000000000', 'Diagramma Cascata', null)
on conflict (id) do nothing;

-- 3) Permessi per le chiavi publishable/anon -----------------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.diagrams to anon, authenticated;
grant select, insert, update, delete on public.active_users to anon, authenticated;

-- 4) RLS permissiva (app senza login) ------------------------
alter table public.diagrams enable row level security;
alter table public.active_users enable row level security;

drop policy if exists "diagrams_all" on public.diagrams;
create policy "diagrams_all" on public.diagrams
  for all to anon, authenticated
  using (true) with check (true);

drop policy if exists "active_users_all" on public.active_users;
create policy "active_users_all" on public.active_users
  for all to anon, authenticated
  using (true) with check (true);

-- 5) Realtime -------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'create publication supabase_realtime';
  end if;
  begin
    execute 'alter publication supabase_realtime add table public.diagrams';
  exception when duplicate_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table public.active_users';
  exception when duplicate_object then null;
  end;
end $$;

-- 6) Verifica rapida -----------------------------------------
select 'diagrams' as tabella, count(*) as righe from public.diagrams
union all
select 'active_users', count(*) from public.active_users;
