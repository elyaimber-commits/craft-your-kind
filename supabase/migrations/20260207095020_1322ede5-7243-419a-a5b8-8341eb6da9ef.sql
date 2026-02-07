-- Add Green Invoice customer ID to patients table
ALTER TABLE public.patients 
ADD COLUMN green_invoice_customer_id text;

-- Add index for fast webhook lookups
CREATE INDEX idx_patients_green_invoice_customer_id 
ON public.patients(green_invoice_customer_id) 
WHERE green_invoice_customer_id IS NOT NULL;