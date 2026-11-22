-- SHINKA 2.0: MFA obligatoria para propietarios y administradores.
-- Ejecutar después de las migraciones 005 y 007.
-- TOTP se gestiona desde Supabase Auth; las políticas siguientes exigen AAL2
-- para que owner/admin accedan a los datos empresariales mediante la API.

begin;

create or replace function public.shinka_requires_admin_mfa()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.company_members cm
    where cm.user_id = (select auth.uid())
      and cm.role in ('owner', 'admin')
  );
$function$;

revoke all on function public.shinka_requires_admin_mfa() from public, anon;
grant execute on function public.shinka_requires_admin_mfa() to authenticated;

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
    else not exists (
      select 1
      from public.company_members cm
      where cm.user_id = (select auth.uid())
        and cm.role in ('owner', 'admin')
    )
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

create or replace function public.update_company_name(
  p_company_id uuid,
  p_name text
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_name text;
  v_saved_name text;
begin
  perform public.shinka_assert_company_admin_aal2(p_company_id);
  if v_user_id is null then
    raise exception 'Debes iniciar sesión.';
  end if;

  v_name := regexp_replace(trim(coalesce(p_name, '')), E'\\s+', ' ', 'g');

  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'El nombre debe tener entre 2 y 120 caracteres.';
  end if;

  update public.companies c
  set name = v_name
  where c.id = p_company_id
    and exists (
      select 1
      from public.company_members cm
      where cm.company_id = c.id
        and cm.user_id = v_user_id
        and cm.role in ('owner', 'admin')
    )
  returning c.name into v_saved_name;

  if v_saved_name is null then
    raise exception 'No tienes permiso para cambiar el nombre de esta empresa.';
  end if;

  return v_saved_name;
end;
$function$;

create or replace function public.get_effective_company_plan_code(p_company_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_plan_code text;
  v_company jsonb;
  v_subscription jsonb;
  v_status text;
begin
  perform public.shinka_assert_company_admin_aal2(p_company_id);
  if v_user_id is null then
    return null;
  end if;

  if not exists (
    select 1
    from public.company_members cm
    where cm.company_id = p_company_id
      and cm.user_id = v_user_id
  ) then
    raise exception 'No perteneces a esta empresa.';
  end if;

  -- La simulación solo se aplica al desarrollador activo que es propietario.
  select s.simulated_plan_code
  into v_plan_code
  from public.developer_plan_sessions s
  where s.company_id = p_company_id
    and s.developer_user_id = v_user_id
    and s.expires_at > now()
    and exists (
      select 1
      from public.platform_developers d
      where d.user_id = v_user_id
        and d.is_active = true
    )
    and exists (
      select 1
      from public.company_members cm
      where cm.company_id = p_company_id
        and cm.user_id = v_user_id
        and cm.role = 'owner'
    )
  limit 1;

  if v_plan_code is not null then
    select pc.plan_code into v_plan_code
    from public.plan_catalog pc
    where lower(pc.plan_code) = lower(v_plan_code)
      and pc.is_active = true
    limit 1;
    return v_plan_code;
  end if;

  select to_jsonb(c)
  into v_company
  from public.companies c
  where c.id = p_company_id;

  if v_company is null then
    raise exception 'La empresa no existe.';
  end if;

  -- Leer la fila como JSON evita depender de nombres concretos de columnas
  -- opcionales de la tabla subscriptions.
  begin
    execute $sql$
      select to_jsonb(s)
      from public.subscriptions s
      where to_jsonb(s)->>'company_id' = $1
        and lower(coalesce(
          to_jsonb(s)->>'status',
          to_jsonb(s)->>'subscription_status',
          ''
        )) in ('active', 'trialing', 'trial', 'past_due')
      order by coalesce(
        to_jsonb(s)->>'updated_at',
        to_jsonb(s)->>'created_at',
        ''
      ) desc
      limit 1
    $sql$
    into v_subscription
    using p_company_id::text;
  exception
    when undefined_table then
      v_subscription := null;
  end;

  if v_subscription is not null then
    v_status := lower(coalesce(
      v_subscription->>'status',
      v_subscription->>'subscription_status',
      ''
    ));
    if v_status in ('active', 'trialing', 'trial', 'past_due') then
      v_plan_code := coalesce(
        v_subscription->>'plan_code',
        v_subscription->>'plan',
        v_subscription->>'tier',
        v_subscription->>'product_code'
      );
    end if;
  end if;

  if v_plan_code is null then
    v_plan_code := coalesce(
      v_company->>'plan_code',
      v_company->>'plan',
      v_company->>'current_plan'
    );
  end if;

  select pc.plan_code into v_plan_code
  from public.plan_catalog pc
  where lower(pc.plan_code) = lower(trim(coalesce(v_plan_code, '')))
    and pc.is_active = true
  limit 1;

  return v_plan_code;
end;
$function$;

create or replace function public.get_company_members(p_company_id uuid)
returns table (
  member_user_id uuid,
  member_role text,
  member_name text,
  member_email text
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
begin
  perform public.shinka_assert_company_admin_aal2(p_company_id);
  if v_user_id is null then
    raise exception 'Debes iniciar sesión.';
  end if;

  if not exists (
    select 1 from public.company_members cm
    where cm.company_id = p_company_id
      and cm.user_id = v_user_id
      and cm.role in ('owner', 'admin')
  ) then
    raise exception 'Solo el propietario o un administrador puede consultar el equipo.';
  end if;

  return query
  select
    cm.user_id,
    cm.role::text,
    coalesce(
      nullif(trim(u.raw_user_meta_data->>'full_name'), ''),
      nullif(trim(u.raw_user_meta_data->>'name'), ''),
      'Miembro'
    )::text,
    coalesce(u.email, '')::text
  from public.company_members cm
  left join auth.users u on u.id = cm.user_id
  where cm.company_id = p_company_id
  order by
    case cm.role
      when 'owner' then 1
      when 'admin' then 2
      when 'manager' then 3
      when 'staff' then 4
      else 5
    end,
    lower(coalesce(u.email, ''));
end;
$function$;

create or replace function public.add_company_member_by_email(
  p_company_id uuid,
  p_email text,
  p_role text
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_actor_role text;
  v_target_id uuid;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_role text := lower(trim(coalesce(p_role, 'staff')));
  v_plan_code text;
  v_value jsonb;
  v_raw text;
  v_limit numeric;
  v_count bigint;
begin
  perform public.shinka_assert_company_admin_aal2(p_company_id);
  if v_user_id is null then
    raise exception 'Debes iniciar sesión.';
  end if;

  select cm.role into v_actor_role
  from public.company_members cm
  where cm.company_id = p_company_id
    and cm.user_id = v_user_id;

  if coalesce(v_actor_role, '') not in ('owner', 'admin') then
    raise exception 'Solo el propietario o un administrador puede añadir miembros.';
  end if;

  if v_email = '' or position('@' in v_email) < 2 then
    raise exception 'Escribe un correo electrónico válido.';
  end if;

  if v_role not in ('admin', 'manager', 'staff', 'viewer') then
    raise exception 'El rol seleccionado no es válido.';
  end if;

  if v_actor_role = 'admin' and v_role = 'admin' then
    raise exception 'Solo el propietario puede asignar el rol de administrador.';
  end if;

  select u.id into v_target_id
  from auth.users u
  where lower(u.email) = v_email
    and u.email_confirmed_at is not null
  limit 1;

  if v_target_id is null then
    raise exception 'No encontramos una cuenta confirmada con ese correo. La persona debe registrarse en SHINKA primero.';
  end if;

  if v_target_id = v_user_id then
    raise exception 'Ya formas parte de esta empresa.';
  end if;

  if exists (
    select 1 from public.company_members cm
    where cm.company_id = p_company_id
      and cm.user_id = v_target_id
  ) then
    raise exception 'Esta persona ya forma parte del equipo.';
  end if;

  v_plan_code := public.get_effective_company_plan_code(p_company_id);
  if v_plan_code is null then
    raise exception 'No pudimos determinar el plan de esta empresa.';
  end if;

  select to_jsonb(e)->'entitlement_value'
  into v_value
  from public.plan_entitlements e
  where e.plan_code = v_plan_code
    and e.entitlement_key = 'max_users'
  limit 1;

  if v_value is null then
    raise exception 'El plan % no tiene configurado max_users.', upper(v_plan_code);
  end if;

  if lower(coalesce(v_value #>> '{}', '')) in ('unlimited', 'infinite', 'ilimitado', 'infinito') then
    v_limit := null;
  else
    begin
      v_limit := (v_value #>> '{}')::numeric;
    exception when invalid_text_representation then
      raise exception 'El límite max_users del plan % no es válido.', upper(v_plan_code);
    end;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_company_id::text), hashtext('max_users'));

  select count(*) into v_count
  from public.company_members cm
  where cm.company_id = p_company_id;

  if v_limit is not null and v_count >= v_limit then
    raise exception 'Tu plan % permite hasta % miembros. Actualmente tienes %.',
      upper(v_plan_code), v_limit, v_count
      using errcode = 'check_violation';
  end if;

  insert into public.company_members (company_id, user_id, role)
  values (p_company_id, v_target_id, v_role);

  return v_target_id;
exception
  when unique_violation then
    raise exception 'Esta persona ya forma parte del equipo.';
end;
$function$;

create or replace function public.set_company_member_role(
  p_company_id uuid,
  p_member_user_id uuid,
  p_role text
)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_actor_role text;
  v_target_role text;
  v_new_role text := lower(trim(coalesce(p_role, '')));
begin
  perform public.shinka_assert_company_admin_aal2(p_company_id);
  if v_user_id is null then
    raise exception 'Debes iniciar sesión.';
  end if;

  select cm.role into v_actor_role
  from public.company_members cm
  where cm.company_id = p_company_id
    and cm.user_id = v_user_id;

  if coalesce(v_actor_role, '') not in ('owner', 'admin') then
    raise exception 'No tienes permiso para administrar el equipo.';
  end if;

  if p_member_user_id = v_user_id then
    raise exception 'No puedes cambiar tu propio rol desde esta pantalla.';
  end if;

  if v_new_role not in ('admin', 'manager', 'staff', 'viewer') then
    raise exception 'El rol seleccionado no es válido.';
  end if;

  select cm.role into v_target_role
  from public.company_members cm
  where cm.company_id = p_company_id
    and cm.user_id = p_member_user_id;

  if v_target_role is null then
    raise exception 'No encontramos a ese miembro en la empresa.';
  end if;

  if v_target_role = 'owner' then
    raise exception 'El propietario principal no puede cambiarse desde esta pantalla.';
  end if;

  if v_actor_role = 'admin' and (v_target_role = 'admin' or v_new_role = 'admin') then
    raise exception 'Los administradores no pueden modificar el rol de otro administrador ni asignar ese rol.';
  end if;

  update public.company_members cm
  set role = v_new_role
  where cm.company_id = p_company_id
    and cm.user_id = p_member_user_id;

  return true;
end;
$function$;

create or replace function public.remove_company_member(
  p_company_id uuid,
  p_member_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_actor_role text;
  v_target_role text;
begin
  perform public.shinka_assert_company_admin_aal2(p_company_id);
  if v_user_id is null then
    raise exception 'Debes iniciar sesión.';
  end if;

  select cm.role into v_actor_role
  from public.company_members cm
  where cm.company_id = p_company_id
    and cm.user_id = v_user_id;

  if coalesce(v_actor_role, '') not in ('owner', 'admin') then
    raise exception 'No tienes permiso para administrar el equipo.';
  end if;

  if p_member_user_id = v_user_id then
    raise exception 'No puedes quitarte a ti mismo desde esta pantalla.';
  end if;

  select cm.role into v_target_role
  from public.company_members cm
  where cm.company_id = p_company_id
    and cm.user_id = p_member_user_id;

  if v_target_role is null then
    raise exception 'No encontramos a ese miembro en la empresa.';
  end if;

  if v_target_role = 'owner' then
    raise exception 'El propietario principal no puede eliminarse.';
  end if;

  if v_actor_role = 'admin' and v_target_role = 'admin' then
    raise exception 'Los administradores no pueden eliminar a otro administrador.';
  end if;

  delete from public.company_members cm
  where cm.company_id = p_company_id
    and cm.user_id = p_member_user_id;

  return true;
end;
$function$;

-- Las políticas RESTRICTIVE se combinan con las políticas de acceso existentes.
-- Los miembros normales conservan sus permisos; owner/admin necesitan un JWT AAL2.
do $policies$
declare
  v_table text;
  v_oid oid;
  v_rls boolean;
  v_has_company_id boolean;
begin
  select c.oid, c.relrowsecurity
    into v_oid, v_rls
  from pg_class c
  where c.oid = to_regclass('public.companies');

  if v_oid is null then
    raise exception 'No existe public.companies.';
  end if;
  if not v_rls then
    raise exception 'RLS está desactivado en public.companies. Activa RLS antes de instalar MFA.';
  end if;

  drop policy if exists shinka_aal2_for_privileged on public.companies;
  create policy shinka_aal2_for_privileged
    on public.companies
    as restrictive
    for all
    to authenticated
    using (public.shinka_company_mfa_access_allowed(id))
    with check (public.shinka_company_mfa_access_allowed(id));

  foreach v_table in array array[
    'company_members',
    'customers',
    'leads',
    'services',
    'orders',
    'payments',
    'activity_logs',
    'ai_usage',
    'subscriptions',
    'billing_events',
    'usage_ledger',
    'developer_plan_sessions'
  ]
  loop
    v_oid := to_regclass(format('public.%I', v_table));
    if v_oid is null then
      continue;
    end if;

    select c.relrowsecurity into v_rls
    from pg_class c
    where c.oid = v_oid;

    if not v_rls then
      raise exception 'RLS está desactivado en public.%. No se aplicó la protección MFA.', v_table;
    end if;

    select exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = v_table
        and c.column_name = 'company_id'
    ) into v_has_company_id;

    if not v_has_company_id then
      raise exception 'La tabla public.% no contiene company_id.', v_table;
    end if;

    execute format('drop policy if exists shinka_aal2_for_privileged on public.%I', v_table);
    execute format(
      'create policy shinka_aal2_for_privileged on public.%I as restrictive for all to authenticated using (public.shinka_company_mfa_access_allowed(company_id)) with check (public.shinka_company_mfa_access_allowed(company_id))',
      v_table
    );
  end loop;
end;
$policies$;

notify pgrst, 'reload schema';

commit;
