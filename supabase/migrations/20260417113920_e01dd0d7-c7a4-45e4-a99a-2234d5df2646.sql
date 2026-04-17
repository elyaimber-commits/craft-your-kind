ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS manual_debt numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual_debt_note text;