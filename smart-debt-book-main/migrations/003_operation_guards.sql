-- Ensure every visible operation has a matching latest immutable revision,
-- and every operation is backed by exactly the right financial postings.
CREATE OR REPLACE FUNCTION public.sdb_verify_operation(p_store uuid, p_op uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_op public.ledger_operations%ROWTYPE; v_revision public.operation_revisions%ROWTYPE;
        v_total numeric; v_expected numeric; v_count integer;
        v_out_count integer; v_in_count integer; v_merge_other_count integer; v_max_revision integer;
BEGIN
  SELECT * INTO v_op FROM public.ledger_operations
   WHERE store_id = p_store AND id = p_op;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO v_revision FROM public.operation_revisions
    WHERE store_id=p_store AND operation_id=p_op AND revision_no=v_op.revision_no;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation has no latest revision' USING ERRCODE='23514';
  END IF;
  SELECT max(revision_no) INTO v_max_revision FROM public.operation_revisions
    WHERE store_id=p_store AND operation_id=p_op;
  IF v_max_revision IS DISTINCT FROM v_op.revision_no THEN
    RAISE EXCEPTION 'operation revision_no must equal newest stored revision' USING ERRCODE='23514';
  END IF;
  IF (v_op.customer_id,v_op.type,v_op.status,v_op.amount_agorot,
      v_op.description,v_op.effective_date,v_op.effective_time)
       IS DISTINCT FROM
     (v_revision.customer_id,v_revision.type,v_revision.status,v_revision.amount_agorot,
      v_revision.description,v_revision.effective_date,v_revision.effective_time) THEN
    RAISE EXCEPTION 'operation differs from its immutable latest revision' USING ERRCODE='23514';
  END IF;

  SELECT count(*),coalesce(sum(signed_amount_agorot),0) INTO v_count,v_total
    FROM public.ledger_entries WHERE store_id=p_store AND operation_id=p_op;
  v_expected := CASE
    WHEN v_op.status <> 'ACTIVE' THEN 0
    WHEN v_op.type = 'PAYMENT' THEN -v_op.amount_agorot
    ELSE v_op.amount_agorot END;
  IF v_total <> v_expected THEN
    RAISE EXCEPTION 'operation postings do not equal its current amount (postings %, expected %)',
      v_total,v_expected USING ERRCODE='23514';
  END IF;

  IF v_op.type = 'MERGE_TRANSFER' THEN
    SELECT count(*) FILTER(WHERE kind='MERGE_OUT'),
           count(*) FILTER(WHERE kind='MERGE_IN'),
           count(*) FILTER(WHERE kind NOT IN ('MERGE_OUT','MERGE_IN'))
      INTO v_out_count,v_in_count,v_merge_other_count
      FROM public.ledger_entries WHERE store_id=p_store AND operation_id=p_op;
    IF v_count <> 2 OR v_out_count <> 1 OR v_in_count <> 1
       OR v_merge_other_count <> 0 OR
       NOT EXISTS (SELECT 1 FROM public.ledger_entries e1
                   JOIN public.ledger_entries e2 ON e2.store_id=e1.store_id
                     AND e2.operation_id=e1.operation_id AND e2.kind='MERGE_IN'
                   WHERE e1.store_id=p_store AND e1.operation_id=p_op
                    AND e1.kind='MERGE_OUT' AND e1.customer_id<>e2.customer_id
                    AND e2.customer_id=v_op.customer_id
                    AND EXISTS (SELECT 1 FROM public.customers source
                                WHERE source.store_id=p_store AND source.id=e1.customer_id
                                  AND source.merged_into_customer_id=e2.customer_id)
                    AND e1.signed_amount_agorot=-v_op.amount_agorot
                    AND e2.signed_amount_agorot=v_op.amount_agorot) THEN
      RAISE EXCEPTION 'merge transfer must have exactly balanced out/in postings'
        USING ERRCODE='23514';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.ledger_entries
               WHERE store_id=p_store AND operation_id=p_op
                 AND kind IN ('MERGE_OUT','MERGE_IN')) THEN
      RAISE EXCEPTION 'business operations cannot contain merge postings'
        USING ERRCODE='23514';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.sdb_guard_operation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM public.sdb_verify_operation(NEW.store_id,NEW.id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sdb_operation_snapshot_guard
AFTER INSERT OR UPDATE ON public.ledger_operations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.sdb_guard_operation();

CREATE OR REPLACE FUNCTION public.sdb_guard_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM public.sdb_verify_operation(NEW.store_id,NEW.operation_id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sdb_revision_snapshot_guard
AFTER INSERT ON public.operation_revisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.sdb_guard_revision();

CREATE OR REPLACE FUNCTION public.sdb_guard_entry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM public.sdb_verify_operation(NEW.store_id,NEW.operation_id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sdb_entry_operation_guard
AFTER INSERT ON public.ledger_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.sdb_guard_entry();
