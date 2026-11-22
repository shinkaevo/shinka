begin;

-- These functions are invoked by PostgreSQL triggers, not by application clients.
-- Remove the default PUBLIC execute grant and direct API-role execution.
revoke execute on function public.handle_new_user()
  from public, anon, authenticated;

revoke execute on function public.rls_auto_enable()
  from public, anon, authenticated;

commit;
