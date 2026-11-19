-- Restrict updates to the current projection and account: every change has a
-- monotonic new revision/version. Historical snapshots remain append-only.
CREATE OR REPLACE FUNCTION public.sdb_operation_version_bump()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.store_id <> OLD.store_id OR
     NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'operation identity and creation metadata are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.revision_no <> OLD.revision_no + 1 THEN
    RAISE EXCEPTION 'each operation update must increment revision_no by exactly one'
      USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER sdb_operation_version_bump
BEFORE UPDATE ON public.ledger_operations
FOR EACH ROW EXECUTE FUNCTION public.sdb_operation_version_bump();

CREATE OR REPLACE FUNCTION public.sdb_account_version_bump()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.customer_id <> OLD.customer_id OR NEW.store_id <> OLD.store_id THEN
    RAISE EXCEPTION 'account identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.ledger_version <> OLD.ledger_version + 1 THEN
    RAISE EXCEPTION 'each account update must increment ledger_version by one'
      USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER sdb_account_version_bump
BEFORE UPDATE ON public.customer_accounts
FOR EACH ROW EXECUTE FUNCTION public.sdb_account_version_bump();

CREATE OR REPLACE FUNCTION public.sdb_no_unmerge()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF OLD.merged_into_customer_id IS NOT NULL AND
     NEW.merged_into_customer_id IS DISTINCT FROM OLD.merged_into_customer_id THEN
     RAISE EXCEPTION 'merge redirects cannot be changed or removed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sdb_customer_no_unmerge
BEFORE UPDATE OF merged_into_customer_id ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.sdb_no_unmerge();
