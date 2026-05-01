
CREATE TABLE public.webhook_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source TEXT NOT NULL,
  received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  status_code INTEGER NOT NULL,
  event_type TEXT,
  external_payment_id TEXT,
  matched_patient_id UUID,
  therapist_id UUID,
  error TEXT,
  payload JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_logs_received_at ON public.webhook_logs(received_at DESC);
CREATE INDEX idx_webhook_logs_source ON public.webhook_logs(source);
CREATE INDEX idx_webhook_logs_therapist ON public.webhook_logs(therapist_id);

ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;

-- Authenticated users can view logs related to them (matched_patient_id belongs to their patient OR therapist_id matches)
-- Simpler: any authenticated user can view all webhook logs (single-user app context, but still scoped by therapist_id when set)
CREATE POLICY "Therapists can view their own webhook logs"
ON public.webhook_logs
FOR SELECT
TO authenticated
USING (therapist_id IS NULL OR auth.uid() = therapist_id);
