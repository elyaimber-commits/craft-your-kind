
CREATE TABLE public.session_overrides (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  therapist_id UUID NOT NULL,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  custom_price NUMERIC NOT NULL,
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Unique per event
CREATE UNIQUE INDEX idx_session_overrides_event ON public.session_overrides(event_id, therapist_id);

ALTER TABLE public.session_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Therapists can view their own overrides" ON public.session_overrides FOR SELECT USING (auth.uid() = therapist_id);
CREATE POLICY "Therapists can insert their own overrides" ON public.session_overrides FOR INSERT WITH CHECK (auth.uid() = therapist_id);
CREATE POLICY "Therapists can update their own overrides" ON public.session_overrides FOR UPDATE USING (auth.uid() = therapist_id);
CREATE POLICY "Therapists can delete their own overrides" ON public.session_overrides FOR DELETE USING (auth.uid() = therapist_id);
