-- SHINKA: edición segura del nombre y aplicación de límites del plan.
-- Ejecutar una sola vez en Supabase SQL Editor.

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

revoke all on function public.update_company_name(uuid, text) from public, anon;
grant execute on function public.update_company_name(uuid, text) to authenticated;


-- Resuelve el plan efectivo: simulación privada del desarrollador primero,
-- luego una suscripción activa, y por último el plan guardado en la empresa.
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

revoke all on function public.get_effective_company_plan_code(uuid) from public, anon;
grant execute on function public.get_effective_company_plan_code(uuid) to authenticated;


-- Devuelve el plan efectivo y las capacidades de ese plan a los miembros
-- de la empresa. La simulación privada solo la ve/aplica su desarrollador.
create or replace function public.get_company_entitlements(p_company_id uuid)
returns table (
  plan_code text,
  entitlement_key text,
  entitlement_value jsonb
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_plan_code text;
begin
  v_plan_code := public.get_effective_company_plan_code(p_company_id);

  return query
  select
    v_plan_code,
    e.entitlement_key,
    to_jsonb(e)->'entitlement_value'
  from (select 1) seed
  left join public.plan_entitlements e
    on e.plan_code = v_plan_code;
end;
$function$;

revoke all on function public.get_company_entitlements(uuid) from public, anon;
grant execute on function public.get_company_entitlements(uuid) to authenticated;


-- Aplicación en base de datos de los límites de clientes, prospectos,
-- servicios y pedidos. Evita saltarse los límites llamando directamente a la API.
create or replace function public.enforce_company_plan_record_limit()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_plan_code text;
  v_entitlement_key text;
  v_label text;
  v_value jsonb;
  v_raw text;
  v_limit numeric;
  v_count bigint;
begin
  -- Las llamadas internas sin usuario autenticado (p. ej. tareas de servicio)
  -- no heredan una simulación de Developer Mode.
  if (select auth.uid()) is null then
    return new;
  end if;

  if tg_table_name = 'customers' then
    v_entitlement_key := 'customers_limit';
    v_label := 'clientes';
  elsif tg_table_name = 'leads' then
    v_entitlement_key := 'leads_limit';
    v_label := 'prospectos';
  elsif tg_table_name = 'services' then
    v_entitlement_key := 'services_limit';
    v_label := 'servicios';
  elsif tg_table_name = 'orders' then
    v_entitlement_key := 'orders_limit';
    v_label := 'pedidos';
  else
    return new;
  end if;

  v_plan_code := public.get_effective_company_plan_code(new.company_id);
  if v_plan_code is null then
    return new;
  end if;

  select to_jsonb(e)->'entitlement_value'
  into v_value
  from public.plan_entitlements e
  where e.plan_code = v_plan_code
    and e.entitlement_key = v_entitlement_key
  limit 1;

  if v_value is null or v_value = 'null'::jsonb then
    return new;
  end if;

  if jsonb_typeof(v_value) = 'boolean' then
    if v_value = 'true'::jsonb then
      return new;
    end if;
    v_limit := 0;
  elsif jsonb_typeof(v_value) = 'object' then
    v_raw := coalesce(v_value->>'limit', v_value->>'max', v_value->>'value');
  else
    v_raw := v_value #>> '{}';
  end if;

  if v_limit is null then
    if lower(trim(coalesce(v_raw, ''))) in ('unlimited', 'infinite', 'ilimitado', 'infinito') then
      return new;
    end if;

    begin
      v_limit := trim(coalesce(v_raw, ''))::numeric;
    exception
      when invalid_text_representation then
        raise exception 'El límite % del plan % no tiene un valor numérico válido.',
          v_entitlement_key, upper(v_plan_code);
    end;
  end if;

  if v_limit < 0 or v_limit <> trunc(v_limit) then
    raise exception 'El límite % del plan % debe ser un entero igual o mayor que cero.',
      v_entitlement_key, upper(v_plan_code);
  end if;

  -- Serializa altas simultáneas de la misma empresa y del mismo recurso.
  perform pg_advisory_xact_lock(hashtext(new.company_id::text), hashtext(v_entitlement_key));

  execute format(
    'select count(*) from public.%I where company_id = $1',
    tg_table_name
  )
  into v_count
  using new.company_id;

  if v_count >= v_limit then
    raise exception 'Tu plan % permite hasta % %.',
      upper(v_plan_code), v_limit, v_label
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;

revoke all on function public.enforce_company_plan_record_limit() from public, anon, authenticated;

drop trigger if exists customers_plan_record_limit on public.customers;
create trigger customers_plan_record_limit
before insert on public.customers
for each row execute function public.enforce_company_plan_record_limit();

drop trigger if exists leads_plan_record_limit on public.leads;
create trigger leads_plan_record_limit
before insert on public.leads
for each row execute function public.enforce_company_plan_record_limit();

drop trigger if exists services_plan_record_limit on public.services;
create trigger services_plan_record_limit
before insert on public.services
for each row execute function public.enforce_company_plan_record_limit();

drop trigger if exists orders_plan_record_limit on public.orders;
create trigger orders_plan_record_limit
before insert on public.orders
for each row execute function public.enforce_company_plan_record_limit();
