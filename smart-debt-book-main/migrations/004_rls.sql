-- RLS must run with a separate non-owner, NOBYPASSRLS runtime role.
-- Role password and secret connection string must be configured OUTSIDE Git.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sdb_app') THEN
   CREATE ROLE sdb_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 END IF;
END $$;

GRANT USAGE ON SCHEMA public TO sdb_app;
GRANT USAGE ON TYPE public.sdb_operation_type,public.sdb_operation_status,public.sdb_entry_kind TO sdb_app;

-- Application client only; Supabase auth users are NOT given table permissions directly.
REVOKE ALL ON TABLE public.stores,public.customers,public.customer_names,
  public.customer_accounts,public.ledger_operations,public.ledger_entries,
  public.operation_revisions,public.audit_events FROM PUBLIC;
REVOKE ALL ON TABLE public.stores,public.customers,public.customer_names,
  public.customer_accounts,public.ledger_operations,public.ledger_entries,
  public.operation_revisions,public.audit_events FROM anon,authenticated;

GRANT SELECT,INSERT,UPDATE ON public.stores,public.customers,
  public.customer_accounts,public.ledger_operations TO sdb_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.customer_names TO sdb_app;
GRANT SELECT,INSERT ON public.ledger_entries,public.operation_revisions,
  public.audit_events TO sdb_app;

CREATE OR REPLACE FUNCTION public.sdb_is_current_store(p_store uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
  SELECT p_store = nullif(current_setting('app.store_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM public.stores s
        WHERE s.id=p_store
          AND s.owner_user_id = nullif(current_setting('app.user_id',true),'')::uuid);
$$;

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_names ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY sdb_stores_owner ON public.stores FOR ALL TO sdb_app
 USING (owner_user_id = nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK (owner_user_id = nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY sdb_customers_tenant ON public.customers FOR ALL TO sdb_app
 USING (public.sdb_is_current_store(store_id)) WITH CHECK (public.sdb_is_current_store(store_id));
CREATE POLICY sdb_names_tenant ON public.customer_names FOR ALL TO sdb_app
 USING (public.sdb_is_current_store(store_id)) WITH CHECK (public.sdb_is_current_store(store_id));
CREATE POLICY sdb_accounts_tenant ON public.customer_accounts FOR ALL TO sdb_app
 USING (public.sdb_is_current_store(store_id)) WITH CHECK (public.sdb_is_current_store(store_id));
CREATE POLICY sdb_operations_tenant ON public.ledger_operations FOR ALL TO sdb_app
 USING (public.sdb_is_current_store(store_id))
 WITH CHECK (public.sdb_is_current_store(store_id) AND
   created_by = nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY sdb_entries_tenant ON public.ledger_entries FOR ALL TO sdb_app
 USING (public.sdb_is_current_store(store_id)) WITH CHECK (public.sdb_is_current_store(store_id));
CREATE POLICY sdb_revisions_tenant ON public.operation_revisions FOR ALL TO sdb_app
 USING (public.sdb_is_current_store(store_id))
 WITH CHECK (public.sdb_is_current_store(store_id) AND
   changed_by = nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY sdb_audit_tenant ON public.audit_events FOR ALL TO sdb_app
 USING (public.sdb_is_current_store(store_id))
 WITH CHECK (public.sdb_is_current_store(store_id) AND
   actor_user_id = nullif(current_setting('app.user_id',true),'')::uuid);

-- PostgreSQL gives EXECUTE on new functions to PUBLIC by default. Explicitly
-- disallow invoking SECURITY DEFINER integrity helpers as ordinary SQL functions.
REVOKE EXECUTE ON FUNCTION public.sdb_verify_customer_structure(uuid,uuid) FROM PUBLIC,sdb_app;
REVOKE EXECUTE ON FUNCTION public.sdb_verify_historical_balance(uuid,uuid) FROM PUBLIC,sdb_app;
REVOKE EXECUTE ON FUNCTION public.sdb_verify_operation(uuid,uuid) FROM PUBLIC,sdb_app;
REVOKE EXECUTE ON FUNCTION public.sdb_verify_reversal() FROM PUBLIC,sdb_app;
REVOKE EXECUTE ON FUNCTION public.sdb_no_merge_cycle() FROM PUBLIC,sdb_app;
