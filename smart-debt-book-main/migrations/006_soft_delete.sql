-- Smart Debt Book — migration 006: logical delete + ة → ه name folding.
-- PRD v1.2 decisions PRD-036, PRD-037, PRD-038, PRD-039.
-- Run by scripts/migrate.mjs inside one transaction. Do not add BEGIN/COMMIT here.

-- 1. Columns -------------------------------------------------------------

ALTER TABLE public.stores
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN data jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.customers
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN data jsonb NOT NULL DEFAULT '{}'::jsonb;

-- One ACTIVE store per owner; a deleted store no longer blocks a new one.
ALTER TABLE public.stores DROP CONSTRAINT stores_one_per_owner;
CREATE UNIQUE INDEX stores_one_active_per_owner
  ON public.stores(owner_user_id) WHERE deleted_at IS NULL;

-- 2. A deleted store hides all its rows from every tenant policy ----------

CREATE OR REPLACE FUNCTION public.sdb_is_current_store(p_store uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT p_store = nullif(current_setting('app.store_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM public.stores s
      WHERE s.id = p_store AND s.deleted_at IS NULL
        AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid);
$$;

-- 3. A customer can be deleted only at balance 0 --------------------------

CREATE OR REPLACE FUNCTION public.sdb_customer_delete_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.customer_accounts a
               WHERE a.store_id = NEW.store_id AND a.customer_id = NEW.id
                 AND a.balance_agorot <> 0) THEN
      RAISE EXCEPTION 'customer can be deleted only at balance 0' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sdb_customer_delete_guard
BEFORE UPDATE OF deleted_at ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.sdb_customer_delete_guard();

-- 4. A deleted customer takes no new money --------------------------------

CREATE OR REPLACE FUNCTION public.sdb_no_money_on_deleted()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.customers c
             WHERE c.store_id = NEW.store_id AND c.id = NEW.customer_id
               AND c.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'deleted customers take no ledger entries' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sdb_no_money_on_deleted
BEFORE INSERT ON public.ledger_entries
FOR EACH ROW EXECUTE FUNCTION public.sdb_no_money_on_deleted();

-- 5. ة and ه are the same letter in names ----------------------------------
-- Same function as 002_integrity.sql, plus ة → ه in the translate() pair.

CREATE OR REPLACE FUNCTION public.sdb_normalize_name(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = public AS $$
  SELECT regexp_replace(
    btrim(lower(translate(regexp_replace(p_name, '[ً-ٰٟـ]', '', 'g'),
                          'أإآٱىة', 'اااايه'))),
    '[[:space:]]+', ' ', 'g'
  );
$$;

-- Refill stored normalized names (the BEFORE trigger recomputes them).
-- On real data this can raise a duplicate-name violation; staging starts empty.
UPDATE public.customer_names SET name = name;
