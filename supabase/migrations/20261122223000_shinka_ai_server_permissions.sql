-- The Edge Function uses service_role for trusted server-side queries.
-- Keep these grants limited to server-side business reads and the AI conversation lifecycle.
grant usage on schema public to service_role;

grant select on
  public.company_members,
  public.companies,
  public.customers,
  public.orders,
  public.leads,
  public.services,
  public.payments,
  public.ai_addon_catalog,
  public.company_ai_subscriptions
to service_role;

grant select, insert, update, delete on
  public.ai_conversations,
  public.ai_messages
to service_role;

grant usage, select on sequence public.ai_messages_id_seq to service_role;

