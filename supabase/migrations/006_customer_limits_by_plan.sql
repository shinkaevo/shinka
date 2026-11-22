-- SHINKA: límites de clientes por plan.
-- CORE = 40 clientes, FLOW = 100 clientes, NEXUS = ilimitado (NULL).

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
  ('core', 'customers_limit', '40'::jsonb),
  ('flow', 'customers_limit', '100'::jsonb),
  ('nexus', 'customers_limit', '"unlimited"'::jsonb);

commit;
