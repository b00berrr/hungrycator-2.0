-- =====================================================================
--  Hungrycator: baza danych
--  Jak użyć: Supabase → SQL Editor → New query → wklej CAŁY plik → Run.
--  Plik można bezpiecznie uruchomić kilka razy.
-- =====================================================================

-- Osoby (Ty i Hubert). Profil tworzy się przy rejestracji w aplikacji.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  cat         text not null default 'ruda' check (cat in ('ruda', 'szara', 'czarna', 'biala')),
  created_at  timestamptz not null default now()
);

-- Baza dań „na kiedyś”.
create table if not exists public.dishes (
  id          bigint generated always as identity primary key,
  name        text not null check (char_length(name) between 1 and 80),
  meal_type   text not null check (meal_type in ('sniadanie', 'obiad', 'kolacja', 'przekaska')),
  tags        text[] not null default '{}',
  added_by    uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Propozycje posiłków.
-- status: czeka | zaakceptowana | odrzucona | zastapiona
create table if not exists public.proposals (
  id          bigint generated always as identity primary key,
  day         date not null,
  meal_type   text not null check (meal_type in ('sniadanie', 'obiad', 'kolacja', 'przekaska')),
  dish_name   text not null check (char_length(dish_name) between 1 and 80),
  comment     text check (char_length(comment) <= 500),
  author      uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  status      text not null default 'czeka' check (status in ('czeka', 'zaakceptowana', 'odrzucona', 'zastapiona')),
  decided_by  uuid references public.profiles (id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists proposals_day_idx on public.proposals (day);

-- Wiadomości w rozmowie o propozycji.
create table if not exists public.messages (
  id           bigint generated always as identity primary key,
  proposal_id  bigint not null references public.proposals (id) on delete cascade,
  author       uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body         text not null check (char_length(body) between 1 and 1000),
  created_at   timestamptz not null default now()
);
create index if not exists messages_proposal_idx on public.messages (proposal_id);

-- Składniki zaakceptowanego dania.
create table if not exists public.ingredients (
  id             bigint generated always as identity primary key,
  proposal_id    bigint not null references public.proposals (id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 80),
  qty            text check (char_length(qty) <= 40),
  have           boolean not null default false,   -- true = „mamy w lodówce”
  added_to_list  boolean not null default false,   -- true = już dodane do zakupów
  created_at     timestamptz not null default now()
);
create index if not exists ingredients_proposal_idx on public.ingredients (proposal_id);

-- Wspólna lista zakupów.
create table if not exists public.shopping_items (
  id           bigint generated always as identity primary key,
  name         text not null check (char_length(name) between 1 and 80),
  qty          text check (char_length(qty) <= 40),
  proposal_id  bigint references public.proposals (id) on delete set null,
  added_by     uuid default auth.uid() references public.profiles (id) on delete set null,
  checked      boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Adresy do wysyłania powiadomień (jeden na każdy telefon).
create table if not exists public.push_subscriptions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  Uprawnienia: tylko zalogowane osoby widzą i zmieniają dane.
--  (Po założeniu dwóch kont wyłącz rejestrację nowych osób w Supabase.)
-- ---------------------------------------------------------------------
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

alter table public.profiles           enable row level security;
alter table public.dishes             enable row level security;
alter table public.proposals          enable row level security;
alter table public.messages           enable row level security;
alter table public.ingredients        enable row level security;
alter table public.shopping_items     enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists "profil: czytanie"   on public.profiles;
drop policy if exists "profil: tworzenie"  on public.profiles;
drop policy if exists "profil: zmiana"     on public.profiles;
create policy "profil: czytanie"  on public.profiles for select to authenticated using (true);
create policy "profil: tworzenie" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profil: zmiana"    on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "wspolne" on public.dishes;
drop policy if exists "wspolne" on public.proposals;
drop policy if exists "wspolne" on public.messages;
drop policy if exists "wspolne" on public.ingredients;
drop policy if exists "wspolne" on public.shopping_items;
create policy "wspolne" on public.dishes         for all to authenticated using (true) with check (true);
create policy "wspolne" on public.proposals      for all to authenticated using (true) with check (true);
create policy "wspolne" on public.messages       for all to authenticated using (true) with check (true);
create policy "wspolne" on public.ingredients    for all to authenticated using (true) with check (true);
create policy "wspolne" on public.shopping_items for all to authenticated using (true) with check (true);

drop policy if exists "tylko swoje" on public.push_subscriptions;
create policy "tylko swoje" on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
--  Odświeżanie na żywo (Realtime): zmiany od jednej osoby od razu
--  pojawiają się u drugiej.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['profiles', 'dishes', 'proposals', 'messages', 'ingredients', 'shopping_items'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
