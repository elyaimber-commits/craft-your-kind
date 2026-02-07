
-- Table to store aliases: map calendar event names to patients
CREATE TABLE public.event_aliases (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  therapist_id UUID NOT NULL,
  event_name TEXT NOT NULL,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Unique constraint: one alias per therapist per event name
ALTER TABLE public.event_aliases ADD CONSTRAINT unique_alias_per_therapist UNIQUE (therapist_id, event_name);

-- Enable RLS
ALTER TABLE public.event_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Therapists can view their own aliases"
  ON public.event_aliases FOR SELECT
  USING (auth.uid() = therapist_id);

CREATE POLICY "Therapists can insert their own aliases"
  ON public.event_aliases FOR INSERT
  WITH CHECK (auth.uid() = therapist_id);

CREATE POLICY "Therapists can delete their own aliases"
  ON public.event_aliases FOR DELETE
  USING (auth.uid() = therapist_id);
