-- Smart Debt Book v1.0 — eight domain tables.
-- Execute as a database migration owner with CREATE privileges (NOT the runtime role).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE public.sdb_operation_type AS ENUM ('DEBT','PAYMENT','OPENING_BALANCE','MERGE_TRANSFER');
CREATE TYPE public.sdb_operation_status AS ENUM ('ACTIVE','CANCELLED','INTERNAL');
CREATE TYPE public.sdb_entry_kind AS ENUM ('ORIGINAL','REVERSAL','CORRECTION','MERGE_OUT','MERGE_IN');

CREATE TABLE public.stores (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    name text NOT NULL CONSTRAINT stores_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    timezone text NOT NULL DEFAULT 'Asia/Jerusalem' CONSTRAINT stores_timezone_check CHECK (timezone = 'Asia/Jerusalem'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT stores_one_per_owner UNIQUE (owner_user_id)
);

CREATE TABLE public.customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
    phone text,
    notes text,
    merged_into_customer_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT customers_tenant_id UNIQUE (store_id,id),
    CONSTRAINT customers_no_self_merge CHECK (merged_into_customer_id IS NULL OR merged_into_customer_id <> id),
    CONSTRAINT customers_merge_same_store FOREIGN KEY (store_id,merged_into_customer_id)
        REFERENCES public.customers(store_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE
);

CREATE TABLE public.customer_names (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    name text NOT NULL CONSTRAINT customer_names_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 180),
    normalized_name text NOT NULL DEFAULT '', -- normalized in a BEFORE trigger in 002
    is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT customer_names_tenant_id UNIQUE (store_id,id),
    CONSTRAINT customer_names_unique_within_store UNIQUE (store_id,normalized_name),
    CONSTRAINT customer_names_customer_fk FOREIGN KEY (store_id,customer_id)
        REFERENCES public.customers(store_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX customer_names_one_primary_per_customer ON public.customer_names(store_id,customer_id) WHERE is_primary;
CREATE INDEX customer_names_customer_idx ON public.customer_names(store_id,customer_id);
CREATE INDEX customer_names_trgm_idx ON public.customer_names USING GIN (normalized_name gin_trgm_ops);

CREATE TABLE public.customer_accounts (
    store_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    balance_agorot bigint NOT NULL DEFAULT 0 CONSTRAINT customer_accounts_positive_balance CHECK (balance_agorot >= 0),
    ledger_version bigint NOT NULL DEFAULT 0 CONSTRAINT customer_accounts_nonnegative_version CHECK (ledger_version >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_id,customer_id),
    CONSTRAINT customer_accounts_customer_fk FOREIGN KEY (store_id,customer_id)
        REFERENCES public.customers(store_id,id) ON DELETE RESTRICT
);
CREATE INDEX customer_accounts_debtors_idx ON public.customer_accounts(store_id,balance_agorot DESC,customer_id) WHERE balance_agorot > 0;

CREATE TABLE public.ledger_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    type public.sdb_operation_type NOT NULL,
    status public.sdb_operation_status NOT NULL DEFAULT 'ACTIVE',
    amount_agorot bigint NOT NULL CONSTRAINT ledger_operations_positive_amount CHECK (amount_agorot > 0),
    description text,
    effective_date date NOT NULL,
    effective_time time without time zone,
    revision_no integer NOT NULL DEFAULT 1 CONSTRAINT ledger_operations_positive_revision CHECK (revision_no >= 1),
    created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ledger_operations_tenant_id UNIQUE (store_id,id),
    CONSTRAINT ledger_operations_customer_fk FOREIGN KEY (store_id,customer_id)
        REFERENCES public.customers(store_id,id) ON DELETE RESTRICT,
    CONSTRAINT ledger_operations_internal_status CHECK
        ((type = 'MERGE_TRANSFER' AND status = 'INTERNAL') OR
         (type <> 'MERGE_TRANSFER' AND status IN ('ACTIVE','CANCELLED')))
);
CREATE INDEX ledger_operations_customer_effective_idx ON public.ledger_operations(
    store_id,customer_id,effective_date DESC,effective_time DESC,created_at DESC,id DESC
) WHERE status = 'ACTIVE';
CREATE INDEX ledger_operations_store_created_idx ON public.ledger_operations(store_id,created_at DESC,id DESC);
CREATE INDEX ledger_operations_store_type_date_idx ON public.ledger_operations(store_id,type,effective_date) WHERE status = 'ACTIVE';

CREATE TABLE public.operation_revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    revision_no integer NOT NULL CONSTRAINT operation_revisions_positive_version CHECK (revision_no >= 1),
    customer_id uuid NOT NULL,
    type public.sdb_operation_type NOT NULL,
    status public.sdb_operation_status NOT NULL,
    amount_agorot bigint NOT NULL CONSTRAINT operation_revisions_positive_amount CHECK (amount_agorot > 0),
    description text,
    effective_date date NOT NULL,
    effective_time time without time zone,
    change_reason text,
    changed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operation_revisions_tenant_id UNIQUE (store_id,id),
    CONSTRAINT operation_revisions_version_unique UNIQUE (store_id,operation_id,revision_no),
    CONSTRAINT operation_revisions_operation_version_fk UNIQUE (store_id,operation_id,id),
    CONSTRAINT operation_revisions_operation_fk FOREIGN KEY (store_id,operation_id)
        REFERENCES public.ledger_operations(store_id,id) ON DELETE RESTRICT,
    CONSTRAINT operation_revisions_customer_fk FOREIGN KEY (store_id,customer_id)
        REFERENCES public.customers(store_id,id) ON DELETE RESTRICT
);

CREATE TABLE public.ledger_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    kind public.sdb_entry_kind NOT NULL,
    signed_amount_agorot bigint NOT NULL CONSTRAINT ledger_entries_nonzero CHECK (signed_amount_agorot <> 0),
    reverses_entry_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ledger_entries_tenant_id UNIQUE (store_id,id),
    CONSTRAINT ledger_entries_operation_revision_fk FOREIGN KEY (store_id,operation_id,revision_id)
        REFERENCES public.operation_revisions(store_id,operation_id,id) ON DELETE RESTRICT,
    CONSTRAINT ledger_entries_customer_fk FOREIGN KEY (store_id,customer_id)
        REFERENCES public.customers(store_id,id) ON DELETE RESTRICT,
    CONSTRAINT ledger_entries_reversal_fk FOREIGN KEY (store_id,reverses_entry_id)
        REFERENCES public.ledger_entries(store_id,id) ON DELETE RESTRICT,
    CONSTRAINT ledger_entries_reversal_shape CHECK
        ((kind = 'REVERSAL' AND reverses_entry_id IS NOT NULL)
         OR (kind <> 'REVERSAL' AND reverses_entry_id IS NULL)),
    CONSTRAINT ledger_entries_merge_sign CHECK (
        (kind = 'MERGE_OUT' AND signed_amount_agorot < 0) OR
        (kind = 'MERGE_IN' AND signed_amount_agorot > 0) OR
        (kind NOT IN ('MERGE_OUT','MERGE_IN')))
);
CREATE UNIQUE INDEX ledger_entries_reverse_once ON public.ledger_entries(store_id,reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX ledger_entries_customer_created_idx ON public.ledger_entries(store_id,customer_id,created_at DESC,id DESC);
CREATE INDEX ledger_entries_operation_idx ON public.ledger_entries(store_id,operation_id);

CREATE TABLE public.audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
    request_id uuid NOT NULL,
    request_hash varchar(64) NOT NULL CONSTRAINT audit_events_request_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    action text NOT NULL CHECK (length(btrim(action)) > 0),
    resource_type text NOT NULL CHECK (length(btrim(resource_type)) > 0),
    resource_id uuid,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    response_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_events_tenant_id UNIQUE (store_id,id),
    CONSTRAINT audit_events_request_once UNIQUE (store_id,request_id)
);
CREATE INDEX audit_events_resource_idx ON public.audit_events(store_id,resource_type,resource_id,created_at DESC);
CREATE INDEX audit_events_created_idx ON public.audit_events(store_id,created_at DESC);
