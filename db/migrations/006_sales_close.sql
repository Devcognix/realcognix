-- =====================================================================
-- 006_sales_close — booking to closed sale.
--
-- bookings gains the full close stage: agreement status, home-loan status, outcome (open / closed_won / closed_lost),
-- cancellation with refund, and payment milestones in booking_payments (one row per milestone: token, on agreement,
-- on slab, on possession ...). Everything is org-scoped like every tenant table:
--   org_id NOT NULL, RLS ENABLEd + FORCEd with the tenant policy, SELECT/INSERT/UPDATE to realcognix_app (no DELETE),
--   composite (org_id, <col>) foreign keys so a row can only reference its own org.
--
-- Run as the owner after 005. Idempotent. db/schema.sql already contains the same objects for fresh installs.
--   docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U realcognix -d realcognix < db/migrations/006_sales_close.sql
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deal_outcome') THEN
    CREATE TYPE deal_outcome AS ENUM ('open', 'closed_won', 'closed_lost');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sale_agreement_status') THEN
    CREATE TYPE sale_agreement_status AS ENUM ('not_started', 'drafted', 'sent', 'signed', 'registered', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN
    CREATE TYPE payment_status AS ENUM ('due', 'paid', 'waived', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loan_status') THEN
    CREATE TYPE loan_status AS ENUM ('not_needed', 'applied', 'sanctioned', 'disbursed', 'rejected');
  END IF;
END $$;

-- UNIQUE (org_id, id) on a referenced table: the target of composite tenant FKs (same name 005 uses).
CREATE OR REPLACE FUNCTION pg_temp.rc_org_key(t regclass) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint u
     WHERE u.conrelid = t AND u.contype IN ('u', 'p')
       AND u.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = t AND attname = 'org_id'),
                            (SELECT attnum FROM pg_attribute WHERE attrelid = t AND attname = 'id')]::int2[]) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (org_id, id)', t, t::text || '_org_id_id_key');
  END IF;
END $f$;
SELECT pg_temp.rc_org_key('bookings');
SELECT pg_temp.rc_org_key('users');

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS booking_ref         text,
  ADD COLUMN IF NOT EXISTS booked_on           date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS agreement_status    sale_agreement_status NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS agreement_signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS registered_at       timestamptz,
  ADD COLUMN IF NOT EXISTS loan_status         loan_status NOT NULL DEFAULT 'not_needed',
  ADD COLUMN IF NOT EXISTS loan_amount_inr     numeric(14,2),
  ADD COLUMN IF NOT EXISTS outcome             deal_outcome NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS closed_at           timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at        timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS refund_amount_inr   numeric(14,2),
  ADD COLUMN IF NOT EXISTS lost_reason         text,
  ADD COLUMN IF NOT EXISTS notes               text,
  ADD COLUMN IF NOT EXISTS created_by          uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_created_by_fkey') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id) ON DELETE SET NULL (created_by);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS bookings_outcome_idx ON bookings (org_id, outcome, booked_on DESC);

CREATE TABLE IF NOT EXISTS booking_payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  booking_id       uuid NOT NULL,
  position         smallint NOT NULL DEFAULT 0,
  label            text NOT NULL,                       -- Token, On agreement, Slab 1 ... On possession
  due_on           date,
  amount_inr       numeric(14,2) NOT NULL CHECK (amount_inr >= 0),
  status           payment_status NOT NULL DEFAULT 'due',
  paid_on          date,
  paid_amount_inr  numeric(14,2),
  method           text,                                -- neft, rtgs, cheque, upi, home_loan
  reference        text,                                -- UTR / cheque number (no bank details)
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_payments_booking_id_fkey FOREIGN KEY (org_id, booking_id) REFERENCES bookings (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS booking_payments_booking_idx ON booking_payments (booking_id, position);
CREATE INDEX IF NOT EXISTS booking_payments_due_idx ON booking_payments (org_id, status, due_on);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'booking_payments_updated_at') THEN
    CREATE TRIGGER booking_payments_updated_at BEFORE UPDATE ON booking_payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  ALTER TABLE booking_payments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE booking_payments FORCE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'booking_payments' AND policyname = 'booking_payments_tenant') THEN
    CREATE POLICY booking_payments_tenant ON booking_payments
      USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
      WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'realcognix_app') THEN
    GRANT SELECT, INSERT, UPDATE ON booking_payments TO realcognix_app;
  END IF;
END $$;
