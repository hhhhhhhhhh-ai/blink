-- ═══════════════════════════════════════════════════════════════
--  Blink — Supabase schema
--  Paste this whole file into  Supabase → SQL Editor → New query → Run.
--  Run it ONCE on a fresh project.
-- ═══════════════════════════════════════════════════════════════

-- ── Tables ─────────────────────────────────────────────────────
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z0-9_.]{3,20}$'),
  display_name text not null default '',
  created_at   timestamptz not null default now()
);

create table public.friendships (
  id         uuid primary key default gen_random_uuid(),
  requester  uuid not null references public.profiles(id) on delete cascade,
  addressee  uuid not null references public.profiles(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  check (requester <> addressee)
);
-- only one friendship row per pair of people, whoever asked first
create unique index friendships_pair_idx
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

create table public.messages (
  id         uuid primary key default gen_random_uuid(),
  sender     uuid not null references public.profiles(id) on delete cascade,
  recipient  uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('text', 'image', 'video')),
  body       text not null default '' check (char_length(body) <= 2000),  -- chat text, or a snap's caption
  media_path text,                                                        -- file in the 'snaps' bucket
  duration   int  not null default 5 check (duration between 1 and 30),   -- seconds a snap can be viewed
  created_at timestamptz not null default now(),
  opened_at  timestamptz,                                                 -- snaps: when the recipient opened it
  read_at    timestamptz,                                                 -- text: when the recipient read it
  check (sender <> recipient),
  check ((kind = 'text' and media_path is null) or (kind <> 'text' and media_path is not null))
);
create index messages_sender_idx    on public.messages (sender, recipient, created_at desc);
create index messages_recipient_idx on public.messages (recipient, created_at desc);

-- ── Helper functions ───────────────────────────────────────────
create function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester = a and f.addressee = b) or (f.requester = b and f.addressee = a))
  );
$$;

-- lets the sign-up form say "username taken" before creating the account
create function public.username_available(p_username text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where username = lower(p_username));
$$;

-- recipient opens a snap → it can never be fetched again (storage policy below checks opened_at)
create function public.open_snap(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set opened_at = now()
  where id = p_id and recipient = auth.uid() and kind <> 'text' and opened_at is null;
$$;

create function public.mark_read(p_friend uuid) returns void
language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
  where sender = p_friend and recipient = auth.uid() and kind = 'text' and read_at is null;
$$;

revoke execute on function public.open_snap(uuid), public.mark_read(uuid), public.are_friends(uuid, uuid)
  from public, anon;
grant execute on function public.open_snap(uuid), public.mark_read(uuid) to authenticated;
grant execute on function public.username_available(text) to anon, authenticated;

-- ── Create a profile automatically when someone signs up ───────
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    lower(new.raw_user_meta_data ->> 'username'),
    coalesce(new.raw_user_meta_data ->> 'display_name', '')
  );
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Row Level Security: who may see / change what ──────────────
alter table public.profiles    enable row level security;
alter table public.friendships enable row level security;
alter table public.messages    enable row level security;

-- profiles: any signed-in user can look people up by username; you can only edit your own
create policy "profiles: read"        on public.profiles for select to authenticated using (true);
create policy "profiles: update own"  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- friendships: you see yours, you can ask, only the person asked can accept, either can end it
create policy "friendships: read"   on public.friendships for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());
create policy "friendships: ask"    on public.friendships for insert to authenticated
  with check (requester = auth.uid() and status = 'pending');
create policy "friendships: accept" on public.friendships for update to authenticated
  using (addressee = auth.uid()) with check (addressee = auth.uid() and status = 'accepted');
create policy "friendships: end"    on public.friendships for delete to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

-- messages: you see the ones you sent/received; you can only send to accepted friends,
-- and a snap's file must live in YOUR own storage folder
create policy "messages: read" on public.messages for select to authenticated
  using (sender = auth.uid() or recipient = auth.uid());
create policy "messages: send" on public.messages for insert to authenticated
  with check (
    sender = auth.uid()
    and public.are_friends(sender, recipient)
    and opened_at is null and read_at is null
    and (media_path is null or media_path like sender::text || '/%')
  );
-- (no update/delete policy on messages: opened/read are set only through the two functions above)

-- ── Storage: private bucket for snaps ──────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('snaps', 'snaps', false, 52428800,
        array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "snaps: upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'snaps' and (storage.foldername(name))[1] = auth.uid()::text);

-- you can read your own uploads, and a snap sent to you — but only until you've opened it
create policy "snaps: read" on storage.objects for select to authenticated
  using (
    bucket_id = 'snaps' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.messages m
                 where m.media_path = name and m.recipient = auth.uid() and m.opened_at is null)
    )
  );

-- the app deletes a snap's file right after downloading it (before marking it opened).
-- NB: Postgres only lets you delete rows you can also read, so this must happen while the snap is still unopened.
create policy "snaps: delete" on storage.objects for delete to authenticated
  using (
    bucket_id = 'snaps' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.messages m
                 where m.media_path = name and m.recipient = auth.uid())
    )
  );

-- ── Realtime: push new messages / friend requests to open apps ─
alter publication supabase_realtime add table public.messages, public.friendships;
