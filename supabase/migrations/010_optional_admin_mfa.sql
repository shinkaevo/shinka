-- SHINKA 2.0: hacer opcional la activación de MFA para owner/admin.
-- Reemplaza la política obligatoria de 009 por MFA opt-in:
-- si owner/admin activa un factor verificado, AAL2 pasa a ser obligatorio;
-- si no lo activa, puede continuar con AAL1. El UI ofrece "Ahora no".

begin;

create or replace function public.shinka_user_has_verified_mfa()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from auth.mfa_factors f
    where f.user_id = (select auth.uid())
      and f.status = 'verified'
  );
$function$;

revoke all on function public.shinka_user_has_verified_mfa() from public, anon, authenticated;

create or replace function public.shinka_company_mfa_access_allowed(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null then false
    when (select auth.jwt()->>'aal') = 'aal2' then true
    when public.shinka_user_has_verified_mfa()
      and exists (
        select 1
        from public.company_members cm
        where cm.user_id = (select auth.uid())
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
       where cm.user_id = (select auth.uid())
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
