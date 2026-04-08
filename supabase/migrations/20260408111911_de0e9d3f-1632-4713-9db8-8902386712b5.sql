-- Fix google_tokens UPDATE policy: add WITH CHECK to prevent user_id reassignment
DROP POLICY IF EXISTS "Users can update their own tokens" ON public.google_tokens;
CREATE POLICY "Users can update their own tokens"
ON public.google_tokens FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Add missing UPDATE policy for event_aliases
CREATE POLICY "Therapists can update their own aliases"
ON public.event_aliases FOR UPDATE
USING (auth.uid() = therapist_id)
WITH CHECK (auth.uid() = therapist_id);