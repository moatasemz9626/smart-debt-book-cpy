-- Database-enforced invariants. Run with elevated migration-owner privileges.

-- Intentionally conservative Arabic normalization; avoid guessing that distinct people are identical.
CREATE OR REPLACE FUNCTION public.sdb_normalize_name(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = public AS $$
  SELECT regexp_replace(
    btrim(lower(translate(regexp_replace(p_name, '[ً-ٰٟـ]', '', 'g'), 'أإآٱى', 'ااااي'))),
    '[[:space:]]+', ' ', 'g'
  );
$$;

CREATE OR REPLACE FUNCTION public.sdb_set_normalized_name()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.normalized_name := public.sdb_normalize_name(NEW.name);
  IF NEW.normalized_name = '' THEN
    RAISE EXCEPTION 'customer name cannot be empty' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers c
             WHERE c.store_id = NEW.store_id AND c.id = NEW.customer_id
               AND c.merged_into_customer_id IS NOT NULL) THEN
    RAISE EXCEPTION 'names cannot belong to a merged customer' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sdb_customer_names_normalize
BEFORE INSERT OR UPDATE OF name,customer_id,store_id ON public.customer_names
FOR EACH ROW EXECUTE FUNCTION public.sdb_set_normalized_name();

-- Exactly one primary name for active customers; zero names for merged customers.
-- A deferred constraint allows: insert customer -> account -> primary name in one transaction.
CREATE OR REPLACE FUNCTION public.sdb_verify_customer_structure(p_store uuid, p_customer uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_merged uuid; v_count int; v_accounts int;
BEGIN
  SELECT merged_into_customer_id INTO v_merged FROM public.customers
  WHERE store_id=p_store AND id=p_customer;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*) INTO v_accounts FROM public.customer_accounts
  WHERE store_id=p_store AND customer_id=p_customer;
  IF v_accounts <> 1 THEN
    RAISE EXCEPTION 'customer must have one financial account' USING ERRCODE = '23514';
  END IF;
  IF v_merged IS NULL THEN
    SELECT count(*) INTO v_count FROM public.customer_names
    WHERE store_id=p_store AND customer_id=p_customer AND is_primary;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'active customer must have exactly one primary name' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT count(*) INTO v_count FROM public.customer_names
    WHERE store_id=p_store AND customer_id=p_customer;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'merged customer may not retain names' USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION public.sdb_customer_structure_from_customers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.sdb_verify_customer_structure(NEW.store_id,NEW.id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sdb_customer_created_guard
AFTER INSERT OR UPDATE OF merged_into_customer_id ON public.customers
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.sdb_customer_structure_from_customers();

CREATE OR REPLACE FUNCTION public.sdb_customer_structure_from_names()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.sdb_verify_customer_structure(OLD.store_id,OLD.customer_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.sdb_verify_customer_structure(NEW.store_id,NEW.customer_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sdb_customer_names_guard
AFTER INSERT OR UPDATE OR DELETE ON public.customer_names
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.sdb_customer_structure_from_names();

-- Explicitly verify reversal is the exact inverse of the referenced entry.
CREATE OR REPLACE FUNCTION public.sdb_verify_reversal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_original public.ledger_entries%ROWTYPE;
BEGIN
  IF NEW.kind <> 'REVERSAL' THEN RETURN NEW; END IF;
  SELECT * INTO v_original FROM public.ledger_entries
   WHERE store_id=NEW.store_id AND id=NEW.reverses_entry_id;
  IF NOT FOUND OR v_original.operation_id <> NEW.operation_id
     OR v_original.customer_id <> NEW.customer_id
     OR v_original.kind IN ('REVERSAL','MERGE_IN','MERGE_OUT')
     OR NEW.signed_amount_agorot <> -v_original.signed_amount_agorot THEN
    RAISE EXCEPTION 'invalid financial reversal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sdb_entries_reversal_guard
BEFORE INSERT ON public.ledger_entries
FOR EACH ROW EXECUTE FUNCTION public.sdb_verify_reversal();

-- Prevent accidental tampering with append-only records.
CREATE OR REPLACE FUNCTION public.sdb_forbid_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER sdb_entries_immutable BEFORE UPDATE OR DELETE ON public.ledger_entries
FOR EACH ROW EXECUTE FUNCTION public.sdb_forbid_change();
CREATE TRIGGER sdb_revisions_immutable BEFORE UPDATE OR DELETE ON public.operation_revisions
FOR EACH ROW EXECUTE FUNCTION public.sdb_forbid_change();
CREATE TRIGGER sdb_audit_immutable BEFORE UPDATE OR DELETE ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.sdb_forbid_change();

-- A customer can only merge into another customer from the same store; never create a cycle.
CREATE OR REPLACE FUNCTION public.sdb_no_merge_cycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_cycle boolean;
BEGIN
  IF NEW.merged_into_customer_id IS NULL THEN RETURN NEW; END IF;
  WITH RECURSIVE chain AS (
    SELECT id, merged_into_customer_id, ARRAY[id] AS visited
      FROM public.customers WHERE store_id=NEW.store_id AND id=NEW.merged_into_customer_id
    UNION ALL
    SELECT c.id,c.merged_into_customer_id,chain.visited||c.id
      FROM public.customers c JOIN chain ON c.id=chain.merged_into_customer_id
     WHERE c.store_id=NEW.store_id AND NOT (c.id=ANY(chain.visited))
  )
  SELECT EXISTS(SELECT 1 FROM chain WHERE id=NEW.id OR merged_into_customer_id=NEW.id)
    INTO v_cycle;
  IF v_cycle THEN
    RAISE EXCEPTION 'customer merge cycle is forbidden' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sdb_customer_merge_cycle
BEFORE INSERT OR UPDATE OF merged_into_customer_id ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.sdb_no_merge_cycle();

-- Historical balance invariant on current visible operations, NOT raw reversal entries.
-- Historical ordering is deterministic, not a claim that unknown clock-times are known:
-- known times first, date-only last, then saved_at and id for tie-breaking.
-- Canonical customer = terminal target of merged_into chain; statement includes all its descendants.
CREATE OR REPLACE FUNCTION public.sdb_verify_historical_balance(p_store uuid, p_customer uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_root uuid; v_min numeric; v_expected numeric; v_actual numeric; v_posted numeric;
BEGIN
  WITH RECURSIVE chain AS (
    SELECT id,merged_into_customer_id,0 AS depth FROM public.customers
     WHERE store_id=p_store AND id=p_customer
    UNION ALL
    SELECT c.id,c.merged_into_customer_id,chain.depth+1
      FROM public.customers c JOIN chain ON c.id=chain.merged_into_customer_id
      WHERE c.store_id=p_store AND chain.depth < 100
  )
  SELECT id INTO v_root FROM chain WHERE merged_into_customer_id IS NULL
  ORDER BY depth DESC LIMIT 1;
  IF v_root IS NULL THEN RETURN; END IF;

  WITH RECURSIVE members AS (
    SELECT id FROM public.customers WHERE store_id=p_store AND id=v_root
    UNION ALL
    SELECT c.id FROM public.customers c JOIN members m ON c.merged_into_customer_id=m.id
      WHERE c.store_id=p_store
  ), streams AS (
    SELECT o.id,o.effective_date,o.effective_time,o.created_at,
      CASE WHEN o.type='PAYMENT' THEN -o.amount_agorot ELSE o.amount_agorot END AS delta
    FROM public.ledger_operations o JOIN members m ON m.id=o.customer_id
    WHERE o.store_id=p_store AND o.status='ACTIVE'
      AND o.type IN ('DEBT','PAYMENT','OPENING_BALANCE')
  ), running AS (
    SELECT sum(delta) OVER (ORDER BY effective_date ASC,
      (effective_time IS NULL) ASC, effective_time ASC NULLS LAST,
      created_at ASC,id ASC) AS b
    FROM streams
  )
  SELECT min(b) INTO v_min FROM running;
  IF coalesce(v_min,0) < 0 THEN
    RAISE EXCEPTION 'historical customer balance cannot become negative' USING ERRCODE='23514';
  END IF;

  WITH RECURSIVE members AS (
    SELECT id FROM public.customers WHERE store_id=p_store AND id=v_root
    UNION ALL
    SELECT c.id FROM public.customers c JOIN members m ON c.merged_into_customer_id=m.id
      WHERE c.store_id=p_store
  )
  SELECT coalesce(sum(CASE WHEN o.type='PAYMENT' THEN -o.amount_agorot ELSE o.amount_agorot END),0)
    INTO v_expected
    FROM public.ledger_operations o JOIN members m ON m.id=o.customer_id
   WHERE o.store_id=p_store AND o.status='ACTIVE'
     AND o.type IN ('DEBT','PAYMENT','OPENING_BALANCE');

  WITH RECURSIVE members AS (
    SELECT id FROM public.customers WHERE store_id=p_store AND id=v_root
    UNION ALL
    SELECT c.id FROM public.customers c JOIN members m ON c.merged_into_customer_id=m.id
      WHERE c.store_id=p_store
  )
  SELECT coalesce(sum(a.balance_agorot),0) INTO v_actual
    FROM public.customer_accounts a JOIN members m ON m.id=a.customer_id
   WHERE a.store_id=p_store;
  IF v_actual <> v_expected THEN
    RAISE EXCEPTION 'customer accounts and active ledger do not reconcile (expected %, actual %)',
       v_expected,v_actual USING ERRCODE='23514';
  END IF;

  -- A separate reconciliation against the immutable physical ledger catches
  -- account tampering and any missing/extra posting, including internal merge moves.
  WITH RECURSIVE members AS (
    SELECT id FROM public.customers WHERE store_id=p_store AND id=v_root
    UNION ALL
    SELECT c.id FROM public.customers c JOIN members m ON c.merged_into_customer_id=m.id
      WHERE c.store_id=p_store
  )
  SELECT coalesce(sum(e.signed_amount_agorot),0) INTO v_posted
    FROM public.ledger_entries e JOIN members m ON m.id=e.customer_id
   WHERE e.store_id=p_store;
  IF v_posted <> v_actual THEN
    RAISE EXCEPTION 'financial postings and customer accounts do not reconcile (posted %, accounts %)',
      v_posted,v_actual USING ERRCODE='23514';
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION public.sdb_history_from_operation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    PERFORM public.sdb_verify_historical_balance(OLD.store_id,OLD.customer_id);
  END IF;
  PERFORM public.sdb_verify_historical_balance(NEW.store_id,NEW.customer_id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sdb_operation_history_guard
AFTER INSERT OR UPDATE ON public.ledger_operations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.sdb_history_from_operation();

CREATE OR REPLACE FUNCTION public.sdb_history_from_account()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM public.sdb_verify_historical_balance(NEW.store_id,NEW.customer_id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sdb_account_history_guard
AFTER INSERT OR UPDATE ON public.customer_accounts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.sdb_history_from_account();

CREATE OR REPLACE FUNCTION public.sdb_history_from_merge()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM public.sdb_verify_historical_balance(NEW.store_id,NEW.id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sdb_merge_history_guard
AFTER UPDATE OF merged_into_customer_id ON public.customers
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.sdb_history_from_merge();
