-- SHINKA: módulo Equipo y límites max_users.
-- Permite consultar miembros, añadir cuentas ya registradas, cambiar roles
-- y retirar miembros. No envía correos de invitación: la persona debe tener
-- una cuenta confirmada en SHINKA.

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
    cm.role,
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

revoke all on function public.get_company_members(uuid) from public, anon;
grant execute on function public.get_company_members(uuid) to authenticated;


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
  if v_user_id is null then
    raise exception 'Debes iniciar sesión.';
  end if;

  select cm.role into v_actor_role
  from public.company_members cm
  where cm.company_id = p_company_id
    and cm.user_id = v_user_id;

  if v_actor_role not in ('owner', 'admin') then
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

revoke all on function public.add_company_member_by_email(uuid, text, text) from public, anon;
grant execute on function public.add_company_member_by_email(uuid, text, text) to authenticated;


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
  if v_user_id is null then
    raise exception 'Debes iniciar sesión.';
  end if;

  select cm.role into v_actor_role
  from public.company_members cm
  where cm.company_id = p_company_id
    and cm.user_id = v_user_id;

  if v_actor_role not in ('owner', 'admin') then
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

revoke all on function public.set_company_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.set_company_member_role(uuid, uuid, text) to authenticated;


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
  if v_user_id is null then
    raise exception 'Debes iniciar sesión.';
  end if;

  select cm.role into v_actor_role
  from public.company_members cm
  where cm.company_id = p_company_id
    and cm.user_id = v_user_id;

  if v_actor_role not in ('owner', 'admin') then
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

revoke all on function public.remove_company_member(uuid, uuid) from public, anon;
grant execute on function public.remove_company_member(uuid, uuid) to authenticated;


-- Protección de base de datos: nadie puede superar max_users insertando
-- directamente en company_members. Se permite la primera fila owner creada
-- por el RPC create_company.
create or replace function public.enforce_company_member_plan_limit()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_actor_role text;
  v_plan_code text;
  v_value jsonb;
  v_raw text;
  v_limit numeric;
  v_count bigint;
begin
  if v_user_id is null then
    return new;
  end if;

  if new.role = 'owner'
     and new.user_id = v_user_id
     and not exists (
       select 1 from public.company_members cm
       where cm.company_id = new.company_id
     ) then
    return new;
  end if;

  select cm.role into v_actor_role
  from public.company_members cm
  where cm.company_id = new.company_id
    and cm.user_id = v_user_id;

  if v_actor_role not in ('owner', 'admin') then
    raise exception 'Solo el propietario o un administrador puede añadir miembros.';
  end if;

  if v_actor_role = 'admin' and new.role in ('owner', 'admin') then
    raise exception 'Los administradores no pueden crear propietarios ni administradores.';
  end if;

  v_plan_code := public.get_effective_company_plan_code(new.company_id);
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

  v_raw := lower(trim(coalesce(v_value #>> '{}', '')));
  if v_raw in ('unlimited', 'infinite', 'ilimitado', 'infinito') then
    return new;
  end if;

  begin
    v_limit := v_raw::numeric;
  exception when invalid_text_representation then
    raise exception 'El límite max_users del plan % no es válido.', upper(v_plan_code);
  end;

  perform pg_advisory_xact_lock(hashtext(new.company_id::text), hashtext('max_users'));

  select count(*) into v_count
  from public.company_members cm
  where cm.company_id = new.company_id;

  if v_count >= v_limit then
    raise exception 'Tu plan % permite hasta % miembros.', upper(v_plan_code), v_limit
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;

revoke all on function public.enforce_company_member_plan_limit() from public, anon, authenticated;

drop trigger if exists company_members_plan_limit on public.company_members;
create trigger company_members_plan_limit
before insert on public.company_members
for each row execute function public.enforce_company_member_plan_limit();
