-- Run once in the existing Gödle Supabase project's SQL editor before deploying index.html.
-- Uses the existing public.puzzle_completions(user_id, puzzle_date) records.
begin;

create table public.hint_color_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  circle_color text not null default 'yellow'
    check (circle_color in ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'brown')),
  square_color text not null default 'green'
    check (square_color in ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'brown')),
  notification_seen_at timestamptz
);

alter table public.hint_color_preferences enable row level security;

-- Clients may read their own unlock and update ONLY their own color columns.
-- No client inserts, deletes, or updates to unlock/notification fields are granted.
revoke all on public.hint_color_preferences from public, anon, authenticated;
grant select on public.hint_color_preferences to authenticated;
grant update (circle_color, square_color) on public.hint_color_preferences to authenticated;

create policy "Read own hint colors" on public.hint_color_preferences
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Update own hint colors" on public.hint_color_preferences
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Existing completion records remain the sole source of streak eligibility.
-- Check for three consecutive dates without storing another streak counter.
create function public.unlock_hint_colors_on_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.hint_color_preferences where user_id = new.user_id) then
    return new;
  end if;

  if exists (
    select 1
    from public.puzzle_completions a
    join public.puzzle_completions b
      on b.user_id = a.user_id and b.puzzle_date::date = a.puzzle_date::date + 1
    join public.puzzle_completions c
      on c.user_id = a.user_id and c.puzzle_date::date = a.puzzle_date::date + 2
    where a.user_id = new.user_id
      and c.puzzle_date::date <= (now() at time zone 'America/New_York')::date
  ) then
    insert into public.hint_color_preferences (user_id)
    values (new.user_id)
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function public.unlock_hint_colors_on_completion() from public, anon, authenticated;
create trigger unlock_hint_colors_after_completion
  after insert or update of user_id, puzzle_date on public.puzzle_completions
  for each row execute function public.unlock_hint_colors_on_completion();

-- Backfill every historical eligible account, including records beyond the UI's
-- 1,000-row fetch limit. Existing players get access without a delayed popup.
insert into public.hint_color_preferences (user_id, notification_seen_at)
select distinct a.user_id, now()
from public.puzzle_completions a
join public.puzzle_completions b
  on b.user_id = a.user_id and b.puzzle_date::date = a.puzzle_date::date + 1
join public.puzzle_completions c
  on c.user_id = a.user_id and c.puzzle_date::date = a.puzzle_date::date + 2
where c.puzzle_date::date <= (now() at time zone 'America/New_York')::date
on conflict (user_id) do nothing;

-- Atomically consume the one-time notification, even with concurrent devices.
-- No user ID parameter: the authenticated caller can only claim their own.
create function public.claim_hint_color_unlock_notification()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.hint_color_preferences
  set notification_seen_at = now()
  where user_id = (select auth.uid()) and notification_seen_at is null;
  return found;
end;
$$;

revoke all on function public.claim_hint_color_unlock_notification() from public, anon, authenticated;
grant execute on function public.claim_hint_color_unlock_notification() to authenticated;

commit;
