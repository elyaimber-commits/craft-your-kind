
-- Create daily expenses table
CREATE TABLE public.daily_expenses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  therapist_id UUID NOT NULL,
  date DATE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  amount NUMERIC NOT NULL DEFAULT 0,
  slot_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Unique constraint: one expense per slot per day per therapist
ALTER TABLE public.daily_expenses ADD CONSTRAINT daily_expenses_unique_slot UNIQUE (therapist_id, date, slot_index);

-- Enable RLS
ALTER TABLE public.daily_expenses ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Therapists can view their own expenses"
  ON public.daily_expenses FOR SELECT
  USING (auth.uid() = therapist_id);

CREATE POLICY "Therapists can insert their own expenses"
  ON public.daily_expenses FOR INSERT
  WITH CHECK (auth.uid() = therapist_id);

CREATE POLICY "Therapists can update their own expenses"
  ON public.daily_expenses FOR UPDATE
  USING (auth.uid() = therapist_id);

CREATE POLICY "Therapists can delete their own expenses"
  ON public.daily_expenses FOR DELETE
  USING (auth.uid() = therapist_id);

-- Trigger for updated_at
CREATE TRIGGER update_daily_expenses_updated_at
  BEFORE UPDATE ON public.daily_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
