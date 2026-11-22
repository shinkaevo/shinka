begin;

-- MFA must be evaluated against the company being accessed.
-- Without this condition, an admin role in an unrelated company can
-- incorrectly affect access checks in another company.
create or replace function public.shinka_company_mfa_access_allowed(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null then false
    when coalesce((select auth.jwt()->>'aal'), 'aal1') = 'aal2' then true
    when public.shinka_user_has_verified_mfa()
      and exists (
        select 1
        from public.company_members cm
        where cm.company_id = p_company_id
          and cm.user_id = (select auth.uid())
          and cm.role in ('owner', 'admin')
      ) then false
    else true
  end;
$function$;

revoke all on function public.shinka_company_mfa_access_allowed(uuid) from public, anon;
grant execute on function public.shinka_company_mfa_access_allowed(uuid) to authenticated;

create or replace function public.shinka_assert_company_admin_aal2(p_company_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is null then
    raise exception 'Debes iniciar sesión.';
  end if;

  if coalesce((select auth.jwt()->>'aal'), 'aal1') <> 'aal2'
     and public.shinka_user_has_verified_mfa()
     and exists (
       select 1
       from public.company_members cm
       where cm.company_id = p_company_id
         and cm.user_id = (select auth.uid())
         and cm.role in ('owner', 'admin')
     ) then
    raise exception 'Por seguridad, verifica tu segundo factor antes de continuar.'
      using errcode = '42501';
  end if;
end;
$function$;

revoke all on function public.shinka_assert_company_admin_aal2(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
