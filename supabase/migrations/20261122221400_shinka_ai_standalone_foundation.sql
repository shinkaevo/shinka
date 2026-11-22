-- SHINKA IA is a separately purchased product, not an entitlement bundled with CORE/FLOW/NEXUS.
-- One credit represents 1,000 combined model input/output tokens.

create table if not exists public.ai_addon_catalog (
  plan_code text primary key,
  display_name text not null,
  description text not null default '',
  monthly_credits integer not null check (monthly_credits > 0),
  monthly_price_cents integer null check (monthly_price_cents is null or monthly_price_cents >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  is_active boolean not null default true,
  display_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.ai_addon_catalog
  (plan_code, display_name, description, monthly_credits, monthly_price_cents, currency, display_order)
values
  ('launch', 'SHINKA IA Launch', 'Para equipos que quieren empezar a trabajar con inteligencia empresarial.', 1000, null, 'USD', 1),
  ('pro', 'SHINKA IA Pro', 'Mayor capacidad para análisis, planificación y trabajo diario.', 5000, null, 'USD', 2),
  ('business', 'SHINKA IA Business', 'Capacidad ampliada para operaciones empresariales intensivas.', 15000, null, 'USD', 3)
on conflict (plan_code) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  monthly_credits = excluded.monthly_credits,
  currency = excluded.currency,
  is_active = true,
  display_order = excluded.display_order,
  updated_at = now();

create table if not exists public.company_ai_subscriptions (
  company_id uuid primary key references public.companies(id) on delete cascade,
  addon_plan_code text not null references public.ai_addon_catalog(plan_code),
  status text not null default 'incomplete'
    check (status in ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'canceled', 'expired')),
  provider text null,
  provider_customer_id text null,
  provider_subscription_id text null,
  current_period_start timestamptz null,
  current_period_end timestamptz null,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_ai_subscription_period_check
    check (
      current_period_start is null
      or current_period_end is null
      or current_period_end > current_period_start
    )
);

alter table public.ai_usage
  add column if not exists request_id uuid,
  add column if not exists credit_units integer not null default 1,
  add column if not exists status text not null default 'completed',
  add column if not exists completed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_usage_credit_units_check'
      and conrelid = 'public.ai_usage'::regclass
  ) then
    alter table public.ai_usage
      add constraint ai_usage_credit_units_check check (credit_units >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_usage_status_check'
      and conrelid = 'public.ai_usage'::regclass
  ) then
    alter table public.ai_usage
      add constraint ai_usage_status_check
      check (status in ('reserved', 'completed', 'failed'));
  end if;
end $$;

create unique index if not exists ai_usage_request_id_unique
  on public.ai_usage(request_id)
  where request_id is not null;

create index if not exists ai_usage_company_period_idx
  on public.ai_usage(company_id, created_at desc)
  where status in ('reserved', 'completed');

create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title text not null default 'Nueva conversación'
    check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id, created_by)
);

create index if not exists ai_conversations_owner_idx
  on public.ai_conversations(company_id, created_by, updated_at desc);

create table if not exists public.ai_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null,
  company_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 20000),
  model text null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  created_at timestamptz not null default now(),
  foreign key (conversation_id, company_id, user_id)
    references public.ai_conversations(id, company_id, created_by)
    on delete cascade
);

create index if not exists ai_messages_conversation_idx
  on public.ai_messages(conversation_id, created_at asc);

-- Remove the AI allowances that were previously bundled with CORE/FLOW/NEXUS.
delete from public.plan_entitlements
where entitlement_key in ('ai_pulses_per_month', 'ai_mind', 'ai_enabled', 'ai_generations_per_month');

alter table public.ai_addon_catalog enable row level security;
alter table public.company_ai_subscriptions enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;

drop policy if exists ai_addon_catalog_read_active on public.ai_addon_catalog;
create policy ai_addon_catalog_read_active
  on public.ai_addon_catalog for select to authenticated
  using (is_active = true);

drop policy if exists company_ai_subscriptions_read_member on public.company_ai_subscriptions;
create policy company_ai_subscriptions_read_member
  on public.company_ai_subscriptions for select to authenticated
  using (public.is_company_member(company_id));

drop policy if exists ai_conversations_owner_read on public.ai_conversations;
create policy ai_conversations_owner_read
  on public.ai_conversations for select to authenticated
  using (
    created_by = (select auth.uid())
    and public.is_company_member(company_id)
    and public.shinka_company_mfa_access_allowed(company_id)
  );

drop policy if exists ai_conversations_owner_insert on public.ai_conversations;
create policy ai_conversations_owner_insert
  on public.ai_conversations for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.is_company_member(company_id)
    and public.shinka_company_mfa_access_allowed(company_id)
  );

drop policy if exists ai_conversations_owner_update on public.ai_conversations;
create policy ai_conversations_owner_update
  on public.ai_conversations for update to authenticated
  using (
    created_by = (select auth.uid())
    and public.is_company_member(company_id)
    and public.shinka_company_mfa_access_allowed(company_id)
  )
  with check (
    created_by = (select auth.uid())
    and public.is_company_member(company_id)
    and public.shinka_company_mfa_access_allowed(company_id)
  );

drop policy if exists ai_conversations_owner_delete on public.ai_conversations;
create policy ai_conversations_owner_delete
  on public.ai_conversations for delete to authenticated
  using (
    created_by = (select auth.uid())
    and public.is_company_member(company_id)
    and public.shinka_company_mfa_access_allowed(company_id)
  );

drop policy if exists ai_messages_owner_read on public.ai_messages;
create policy ai_messages_owner_read
  on public.ai_messages for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.is_company_member(company_id)
    and exists (
      select 1
      from public.ai_conversations c
      where c.id = conversation_id
        and c.company_id = ai_messages.company_id
        and c.created_by = (select auth.uid())
    )
    and public.shinka_company_mfa_access_allowed(company_id)
  );

revoke all on public.ai_addon_catalog from anon;
revoke insert, update, delete on public.ai_addon_catalog from authenticated;
grant select on public.ai_addon_catalog to authenticated;

revoke all on public.company_ai_subscriptions from anon;
revoke insert, update, delete on public.company_ai_subscriptions from anon, authenticated;
grant select on public.company_ai_subscriptions to authenticated;

revoke all on public.ai_conversations from anon;
grant select, insert, update, delete on public.ai_conversations to authenticated;

revoke all on public.ai_messages from anon, authenticated;
grant select on public.ai_messages to authenticated;
grant usage, select on sequence public.ai_messages_id_seq to service_role;

create or replace function public.shinka_ai_reserve_credits(
  p_company_id uuid,
  p_user_id uuid,
  p_request_id uuid,
  p_reserved_credits integer,
  p_model text
)
returns table (
  allowed boolean,
  plan_name text,
  monthly_credits integer,
  used_credits integer,
  remaining_credits integer,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan_name text;
  v_limit integer;
  v_used integer;
  v_period_start timestamptz;
  v_period_end timestamptz;
begin
  if p_company_id is null or p_user_id is null or p_request_id is null then
    raise exception 'Solicitud incompleta.';
  end if;
  if p_reserved_credits is null or p_reserved_credits < 1 or p_reserved_credits > 50 then
    raise exception 'Reserva de créditos fuera del rango permitido.';
  end if;

  if not exists (
    select 1 from public.company_members cm
    where cm.company_id = p_company_id and cm.user_id = p_user_id
  ) then
    raise exception 'El usuario no pertenece a esta empresa.';
  end if;

  select c.display_name, c.monthly_credits, s.current_period_start, s.current_period_end
    into v_plan_name, v_limit, v_period_start, v_period_end
  from public.company_ai_subscriptions s
  join public.ai_addon_catalog c on c.plan_code = s.addon_plan_code
  where s.company_id = p_company_id
    and s.status in ('active', 'trialing')
    and c.is_active = true
  for update of s;

  if not found
     or v_period_start is null
     or v_period_end is null
     or now() < v_period_start
     or now() >= v_period_end then
    return query select false, null::text, 0, 0, 0,
      'Esta empresa no tiene una suscripción activa a SHINKA IA.';
    return;
  end if;

  select coalesce(sum(u.credit_units), 0)::integer
    into v_used
  from public.ai_usage u
  where u.company_id = p_company_id
    and u.created_at >= v_period_start
    and u.created_at < v_period_end
    and u.status in ('reserved', 'completed');

  if v_used + p_reserved_credits > v_limit then
    return query select false, v_plan_name, v_limit, v_used,
      greatest(v_limit - v_used, 0),
      'Has alcanzado el consumo disponible de SHINKA IA para este período.';
    return;
  end if;

  insert into public.ai_usage (
    company_id, user_id, provider, model, feature,
    input_tokens, output_tokens, request_id, credit_units, status
  ) values (
    p_company_id, p_user_id, 'openai', coalesce(p_model, 'gpt-6.2-astra'),
    'assistant', 0, 0, p_request_id, p_reserved_credits, 'reserved'
  );

  return query select true, v_plan_name, v_limit,
    v_used + p_reserved_credits,
    greatest(v_limit - v_used - p_reserved_credits, 0),
    null::text;
end;
$function$;

create or replace function public.shinka_ai_finalize_usage(
  p_request_id uuid,
  p_input_tokens integer,
  p_output_tokens integer,
  p_model text,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_status text := lower(coalesce(p_status, 'failed'));
  v_input integer := greatest(coalesce(p_input_tokens, 0), 0);
  v_output integer := greatest(coalesce(p_output_tokens, 0), 0);
begin
  if p_request_id is null or v_status not in ('completed', 'failed') then
    raise exception 'Finalización de consumo no válida.';
  end if;

  update public.ai_usage
  set input_tokens = v_input,
      output_tokens = v_output,
      model = coalesce(nullif(p_model, ''), model),
      status = v_status,
      credit_units = case
        when v_status = 'completed'
          then greatest(1, ceil((v_input + v_output)::numeric / 1000)::integer)
        else 0
      end,
      completed_at = now()
  where request_id = p_request_id
    and status = 'reserved';

  if not found then
    raise exception 'No se encontró una reserva pendiente para esta solicitud.';
  end if;
end;
$function$;

revoke all on function public.shinka_ai_reserve_credits(uuid, uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.shinka_ai_finalize_usage(uuid, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.shinka_ai_reserve_credits(uuid, uuid, uuid, integer, text) to service_role;
grant execute on function public.shinka_ai_finalize_usage(uuid, integer, integer, text, text) to service_role;

comment on table public.ai_addon_catalog is
  'Standalone SHINKA IA add-on plans. Not bundled with CORE, FLOW, or NEXUS.';
comment on table public.company_ai_subscriptions is
  'Per-company SHINKA IA add-on subscription; activated by trusted billing workflows only.';
comment on table public.ai_conversations is
  'Private AI conversations owned by one authenticated company member.';
comment on table public.ai_messages is
  'Private conversation messages; assistant writes are performed by the trusted Edge Function.';
comment on function public.shinka_ai_reserve_credits(uuid, uuid, uuid, integer, text) is
  'Atomically reserves token-based AI credits for a valid company add-on subscription. Service-role only.';
