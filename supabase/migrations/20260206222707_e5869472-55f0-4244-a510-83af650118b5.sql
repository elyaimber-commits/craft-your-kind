
-- Create payments table to track billing per patient per month
CREATE TABLE public.payments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  therapist_id UUID NOT NULL,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  month TEXT NOT NULL, -- format: "2026-02"
  amount NUMERIC NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  paid BOOLEAN NOT NULL DEFAULT false,
  paid_at TIMESTAMP WITH TIME ZONE,
  receipt_number TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(patient_id, month)
);

-- Enable RLS
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Therapists can view their own payments"
ON public.payments FOR SELECT
USING (auth.uid() = therapist_id);

CREATE POLICY "Therapists can insert their own payments"
ON public.payments FOR INSERT
WITH CHECK (auth.uid() = therapist_id);

CREATE POLICY "Therapists can update their own payments"
ON public.payments FOR UPDATE
USING (auth.uid() = therapist_id);

CREATE POLICY "Therapists can delete their own payments"
ON public.payments FOR DELETE
USING (auth.uid() = therapist_id);

-- Trigger for updated_at
CREATE TRIGGER update_payments_updated_at
BEFORE UPDATE ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
