
-- Add commission fields to patients table
ALTER TABLE public.patients 
ADD COLUMN IF NOT EXISTS commission_enabled boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS commission_type text NOT NULL DEFAULT 'percent',
ADD COLUMN IF NOT EXISTS commission_value numeric;

-- Add analysis-related fields to payments table
ALTER TABLE public.payments 
ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'paid',
ADD COLUMN IF NOT EXISTS external_source text,
ADD COLUMN IF NOT EXISTS external_payment_id text;

-- Add unique constraint for deduplication
CREATE UNIQUE INDEX IF NOT EXISTS payments_external_source_payment_id_unique 
ON public.payments (external_source, external_payment_id) 
WHERE external_source IS NOT NULL AND external_payment_id IS NOT NULL;
