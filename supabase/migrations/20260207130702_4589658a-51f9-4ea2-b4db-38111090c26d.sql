-- Add column to track which specific event IDs have been paid
ALTER TABLE public.payments ADD COLUMN paid_event_ids text[] DEFAULT '{}';
