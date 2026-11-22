-- SHINKA: límites de clientes por plan.
-- CORE = 40 clientes, FLOW = 100 clientes, NEXUS = ilimitado (JSON string).

begin;

delete from public.plan_entitlements
where entitlement_key = 'customers_limit'
  and plan_code in ('core', 'flow', 'nexus');

insert into public.plan_entitlements (
  plan_code,
  entitlement_key,
  entitlement_value
)
values
  ('core', 'customers_limit', to_jsonb(40)),
  ('flow', 'customers_limit', to_jsonb(100)),
  ('nexus', 'customers_limit', to_jsonb('unlimited'::text));

commit;
