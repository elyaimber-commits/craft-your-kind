-- 1. Create manual_debts table
CREATE TABLE public.manual_debts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_id uuid NOT NULL,
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  amount numeric NOT NULL DEFAULT 0,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- 2. Indexes
CREATE INDEX idx_manual_debts_patient ON public.manual_debts(patient_id);
CREATE INDEX idx_manual_debts_therapist ON public.manual_debts(therapist_id);

-- 3. Enable RLS
ALTER TABLE public.manual_debts ENABLE ROW LEVEL SECURITY;

-- 4. RLS policies
CREATE POLICY "Therapists can view their own manual debts"
  ON public.manual_debts FOR SELECT
  USING (auth.uid() = therapist_id);

CREATE POLICY "Therapists can insert their own manual debts"
  ON public.manual_debts FOR INSERT
  WITH CHECK (auth.uid() = therapist_id);

CREATE POLICY "Therapists can update their own manual debts"
  ON public.manual_debts FOR UPDATE
  USING (auth.uid() = therapist_id)
  WITH CHECK (auth.uid() = therapist_id);

CREATE POLICY "Therapists can delete their own manual debts"
  ON public.manual_debts FOR DELETE
  USING (auth.uid() = therapist_id);

-- 5. Trigger for updated_at
CREATE TRIGGER update_manual_debts_updated_at
  BEFORE UPDATE ON public.manual_debts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- 6. Migrate existing manual_debt from patients table
INSERT INTO public.manual_debts (therapist_id, patient_id, amount, note)
SELECT therapist_id, id, manual_debt, manual_debt_note
FROM public.patients
WHERE manual_debt > 0;

-- 7. Drop old columns from patients
ALTER TABLE public.patients
  DROP COLUMN IF EXISTS manual_debt,
  DROP COLUMN IF EXISTS manual_debt_note;