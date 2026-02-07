
CREATE TABLE public.ignored_calendar_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  therapist_id UUID NOT NULL,
  event_name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.ignored_calendar_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Therapists can view their own ignored events"
  ON public.ignored_calendar_events FOR SELECT
  USING (auth.uid() = therapist_id);

CREATE POLICY "Therapists can insert their own ignored events"
  ON public.ignored_calendar_events FOR INSERT
  WITH CHECK (auth.uid() = therapist_id);

CREATE POLICY "Therapists can delete their own ignored events"
  ON public.ignored_calendar_events FOR DELETE
  USING (auth.uid() = therapist_id);

CREATE UNIQUE INDEX idx_ignored_calendar_events_unique 
  ON public.ignored_calendar_events (therapist_id, event_name);
