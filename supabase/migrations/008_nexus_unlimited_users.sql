-- SHINKA: plazas del equipo por plan.
-- CORE conserva 2 miembros; FLOW conserva 5; NEXUS pasa a ilimitado.
-- No modifica los límites de CORE ni FLOW.

update public.plan_entitlements
set entitlement_value = to_jsonb('unlimited'::text),
    updated_at = now()
where plan_code = 'nexus'
  and entitlement_key = 'max_users';

do $block$
begin
  if not exists (
    select 1
    from public.plan_entitlements
    where plan_code = 'nexus'
      and entitlement_key = 'max_users'
  ) then
    raise exception 'No existe max_users para nexus en plan_entitlements. No se modificó ningún otro plan.';
  end if;
end;
$block$;
