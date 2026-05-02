
CREATE TABLE public.session_summaries (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  therapist_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  event_id text NOT NULL,
  drive_file_id text,
  drive_file_name text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.session_summaries ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX session_summaries_therapist_event_unique
  ON public.session_summaries (therapist_id, event_id);

CREATE INDEX session_summaries_therapist_patient_idx
  ON public.session_summaries (therapist_id, patient_id);

CREATE POLICY "Therapists can view their own summaries"
  ON public.session_summaries FOR SELECT
  USING (auth.uid() = therapist_id);

CREATE POLICY "Therapists can insert their own summaries"
  ON public.session_summaries FOR INSERT
  WITH CHECK (auth.uid() = therapist_id);

CREATE POLICY "Therapists can update their own summaries"
  ON public.session_summaries FOR UPDATE
  USING (auth.uid() = therapist_id)
  WITH CHECK (auth.uid() = therapist_id);

CREATE POLICY "Therapists can delete their own summaries"
  ON public.session_summaries FOR DELETE
  USING (auth.uid() = therapist_id);

CREATE TRIGGER update_session_summaries_updated_at
  BEFORE UPDATE ON public.session_summaries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
