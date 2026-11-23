-- SHINKA: 14-day company trial, subscription access gate, and data preservation.
-- Existing workspace data is never deleted or modified by this migration.

create or replace function public.shinka_company_has_product_access(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.company_members cm
      join public.companies c on c.id = cm.company_id
      where cm.company_id = p_company_id
        and cm.user_id = (select auth.uid())
        and c.status = 'active'
    )
    and (
      exists (
        select 1 from public.subscriptions s
        where s.company_id = p_company_id
          and s.status = 'active'
          and (s.current_period_end is null or s.current_period_end > now())
      )
      or exists (
        select 1 from public.subscriptions s
        where s.company_id = p_company_id
          and s.status = 'trialing'
          and s.trial_starts_at <= now()
          and s.trial_ends_at > now()
      )
      or exists (
        select 1
        from public.developer_plan_sessions dps
        join public.platform_developers pd
          on pd.user_id = dps.developer_user_id and pd.is_active = true
        join public.company_members cm
          on cm.company_id = dps.company_id
         and cm.user_id = dps.developer_user_id
         and cm.role = 'owner'
        where dps.company_id = p_company_id
          and dps.developer_user_id = (select auth.uid())
          and dps.expires_at > now()
      )
      or exists (
        select 1 from public.companies c
        where c.id = p_company_id and c.plan in ('basic', 'pro', 'lifetime')
      )
    );
$function$;

revoke all on function public.shinka_company_has_product_access(uuid) from public, anon;
grant execute on function public.shinka_company_has_product_access(uuid) to authenticated;

create or replace function public.shinka_get_company_subscription_status(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_subscription public.subscriptions%rowtype;
  v_company public.companies%rowtype;
  v_plan_name text;
  v_is_developer boolean := false;
  v_has_access boolean := false;
  v_display_status text;
  v_days_remaining integer := 0;
begin
  if v_user_id is null then
    raise exception 'Debes iniciar sesión.';
  end if;

  if not exists (
    select 1 from public.company_members cm
    where cm.company_id = p_company_id and cm.user_id = v_user_id
  ) then
    raise exception 'No perteneces a esta empresa.';
  end if;

  perform public.shinka_assert_company_admin_aal2(p_company_id);

  select c.* into v_company
  from public.companies c
  where c.id = p_company_id;

  if not found then
    raise exception 'La empresa no existe.';
  end if;

  select s.* into v_subscription
  from public.subscriptions s
  where s.company_id = p_company_id
  order by
    case when s.status = 'active' then 0 when s.status = 'trialing' then 1 else 2 end,
    s.updated_at desc,
    s.created_at desc
  limit 1;

  select exists (
    select 1
    from public.developer_plan_sessions dps
    join public.platform_developers pd
      on pd.user_id = dps.developer_user_id and pd.is_active = true
    join public.company_members cm
      on cm.company_id = dps.company_id
     and cm.user_id = dps.developer_user_id
     and cm.role = 'owner'
    where dps.company_id = p_company_id
      and dps.developer_user_id = v_user_id
      and dps.expires_at > now()
  ) into v_is_developer;

  if v_subscription.id is not null then
    select pc.display_name into v_plan_name
    from public.plan_catalog pc
    where pc.plan_code = v_subscription.plan_code;

    v_has_access :=
      (v_subscription.status = 'active'
        and (v_subscription.current_period_end is null or v_subscription.current_period_end > now()))
      or
      (v_subscription.status = 'trialing'
        and v_subscription.trial_starts_at <= now()
        and v_subscription.trial_ends_at > now());

    if v_subscription.status = 'trialing' and v_subscription.trial_ends_at > now() then
      v_days_remaining := greatest(
        0,
        ceil(extract(epoch from (v_subscription.trial_ends_at - now())) / 86400)::integer
      );
    end if;
  else
    v_has_access := v_company.plan in ('basic', 'pro', 'lifetime');
  end if;

  v_has_access := v_has_access or v_is_developer;

  v_display_status := case
    when v_is_developer then 'developer'
    when v_subscription.id is null and v_has_access then 'legacy_active'
    when v_subscription.status = 'trialing'
      and coalesce(v_subscription.trial_ends_at, '-infinity'::timestamptz) <= now() then 'expired'
    when v_subscription.id is null then 'missing'
    else v_subscription.status
  end;

  return jsonb_build_object(
    'has_access', v_has_access,
    'status', v_display_status,
    'plan_code', coalesce(v_subscription.plan_code, nullif(v_company.plan, 'trial')),
    'plan_name', coalesce(v_plan_name, case when v_company.plan in ('basic', 'pro', 'lifetime') then upper(v_company.plan) end),
    'trial_starts_at', v_subscription.trial_starts_at,
    'trial_ends_at', v_subscription.trial_ends_at,
    'current_period_end', v_subscription.current_period_end,
    'days_remaining', v_days_remaining
  );
end;
$function$;

revoke all on function public.shinka_get_company_subscription_status(uuid) from public, anon;
grant execute on function public.shinka_get_company_subscription_status(uuid) to authenticated;

create or replace function public.shinka_start_company_trial()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_started_at timestamptz := coalesce(new.created_at, now());
  v_price integer;
  v_currency text;
begin
  select pc.monthly_price_cents, pc.currency into v_price, v_currency
  from public.plan_catalog pc
  where pc.plan_code = 'core' and pc.is_active = true;

  if v_price is null then
    raise exception 'No se puede iniciar la prueba: SHINKA CORE no está publicado.';
  end if;

  insert into public.subscriptions (
    company_id, plan_code, provider, status, billing_interval, currency,
    unit_amount_cents, current_period_start, current_period_end,
    trial_starts_at, trial_ends_at, cancel_at_period_end, created_at, updated_at
  ) values (
    new.id, 'core', 'shinka_free_trial', 'trialing', 'month', v_currency,
    v_price, v_started_at, v_started_at + interval '14 days',
    v_started_at, v_started_at + interval '14 days', false, now(), now()
  );

  return new;
end;
$function$;

revoke all on function public.shinka_start_company_trial() from public, anon, authenticated;

drop trigger if exists shinka_company_trial_after_insert on public.companies;
create trigger shinka_company_trial_after_insert
after insert on public.companies
for each row execute function public.shinka_start_company_trial();

-- Give existing workspaces their initial launch trial from migration time.
-- No existing customers, leads, services, orders, payments, or messages are deleted.
insert into public.subscriptions (
  company_id, plan_code, provider, status, billing_interval, currency,
  unit_amount_cents, current_period_start, current_period_end,
  trial_starts_at, trial_ends_at, cancel_at_period_end, created_at, updated_at
)
select
  c.id, 'core', 'shinka_free_trial', 'trialing', 'month', pc.currency,
  pc.monthly_price_cents, now(), now() + interval '14 days',
  now(), now() + interval '14 days', false, now(), now()
from public.companies c
cross join public.plan_catalog pc
where pc.plan_code = 'core'
  and pc.is_active = true
  and c.status = 'active'
  and not exists (
    select 1 from public.subscriptions s where s.company_id = c.id
  );

create or replace function public.get_effective_company_plan_code(p_company_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_plan_code text;
begin
  perform public.shinka_assert_company_admin_aal2(p_company_id);

  if v_user_id is null then
    return null;
  end if;

  if not exists (
    select 1 from public.company_members cm
    where cm.company_id = p_company_id and cm.user_id = v_user_id
  ) then
    raise exception 'No perteneces a esta empresa.';
  end if;

  select s.simulated_plan_code into v_plan_code
  from public.developer_plan_sessions s
  where s.company_id = p_company_id
    and s.developer_user_id = v_user_id
    and s.expires_at > now()
    and exists (
      select 1 from public.platform_developers d
      where d.user_id = v_user_id and d.is_active = true
    )
    and exists (
      select 1 from public.company_members cm
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

  if not public.shinka_company_has_product_access(p_company_id) then
    return null;
  end if;

  select pc.plan_code into v_plan_code
  from public.subscriptions s
  join public.plan_catalog pc on pc.plan_code = s.plan_code
  where s.company_id = p_company_id
    and pc.is_active = true
    and (
      (s.status = 'active' and (s.current_period_end is null or s.current_period_end > now()))
      or
      (s.status = 'trialing' and s.trial_starts_at <= now() and s.trial_ends_at > now())
    )
  order by case when s.status = 'active' then 0 else 1 end,
           s.updated_at desc, s.created_at desc
  limit 1;

  if v_plan_code is not null then
    return v_plan_code;
  end if;

  select c.plan into v_plan_code
  from public.companies c
  where c.id = p_company_id and c.plan in ('basic', 'pro', 'lifetime')
  limit 1;

  return v_plan_code;
end;
$function$;

-- Preserve rows in the database while blocking product-data access after expiry.
do $block$
declare
  v_table text;
begin
  foreach v_table in array array[
    'activity_logs',
    'ai_conversations',
    'ai_messages',
    'ai_usage',
    'billing_events',
    'company_ai_subscriptions',
    'customers',
    'leads',
    'services',
    'orders',
    'payments',
    'usage_ledger'
  ]
  loop
    execute format('drop policy if exists shinka_subscription_required on public.%I', v_table);
    execute format(
      'create policy shinka_subscription_required on public.%I as restrictive for all to authenticated using (public.shinka_company_has_product_access(company_id)) with check (public.shinka_company_has_product_access(company_id))',
      v_table
    );
  end loop;
end;
$block$;
