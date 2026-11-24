-- PayPal subscription billing foundation for SHINKA.
-- Only PayPal plan identifiers and webhook metadata live in Postgres. Credentials stay in Edge Function secrets.

alter table public.plan_catalog
  add column if not exists paypal_plan_id text,
  add column if not exists paypal_environment text,
  add column if not exists provider_approval_url text;

alter table public.subscriptions
  add column if not exists paypal_pending_plan_code text;

alter table public.ai_addon_catalog
  add column if not exists paypal_plan_id text,
  add column if not exists paypal_environment text;

alter table public.company_ai_subscriptions
  add column if not exists provider_approval_url text;

create table if not exists public.billing_provider_config (
  provider text primary key check (provider = 'paypal'),
  environment text not null check (environment in ('sandbox', 'live')),
  webhook_id text not null,
  product_ids jsonb not null default '{}'::jsonb check (jsonb_typeof(product_ids) = 'object'),
  updated_at timestamptz not null default now()
);
alter table public.billing_provider_config enable row level security;
revoke all on public.billing_provider_config from public, anon, authenticated;
grant all on public.billing_provider_config to service_role;

create unique index if not exists billing_events_provider_event_id_unique
  on public.billing_events(provider, provider_event_id);

-- Suggested low-cost monthly add-on prices: Launch $1.49, Pro $4.99, Business $9.99.
update public.ai_addon_catalog
set monthly_price_cents = case plan_code
  when 'launch' then 149 when 'pro' then 499 when 'business' then 999
  else monthly_price_cents end,
  updated_at = now()
where plan_code in ('launch', 'pro', 'business');
