CREATE TABLE public.payment_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  therapist_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  month TEXT NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (therapist_id, patient_id, month)
);

ALTER TABLE public.payment_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Therapists can view their own payment requests"
  ON public.payment_requests FOR SELECT
  USING (auth.uid() = therapist_id);

CREATE POLICY "Therapists can insert their own payment requests"
  ON public.payment_requests FOR INSERT
  WITH CHECK (auth.uid() = therapist_id);

CREATE POLICY "Therapists can update their own payment requests"
  ON public.payment_requests FOR UPDATE
  USING (auth.uid() = therapist_id);

CREATE POLICY "Therapists can delete their own payment requests"
  ON public.payment_requests FOR DELETE
  USING (auth.uid() = therapist_id);

CREATE INDEX idx_payment_requests_therapist_month ON public.payment_requests(therapist_id, month);