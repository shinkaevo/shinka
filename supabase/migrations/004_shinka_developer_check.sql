-- SHINKA 2.0 · Expose a safe boolean check for the private developer allowlist.
-- This function reveals only whether the currently authenticated user is active.
-- It does not expose developer records or allowlist membership for other users.

begin;

create or replace function public.is_platform_developer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.platform_developers d
    where d.user_id = (select auth.uid())
      and d.is_active = true
  );
$function$;

revoke all on function public.is_platform_developer() from public, anon;
grant execute on function public.is_platform_developer() to authenticated;

comment on function public.is_platform_developer() is
  'Returns true only for the authenticated user when the private platform developer allowlist is active.';

commit;
