
-- Add billing_type and parent_patient_id to patients table
ALTER TABLE public.patients 
ADD COLUMN billing_type text NOT NULL DEFAULT 'monthly',
ADD COLUMN parent_patient_id uuid REFERENCES public.patients(id) ON DELETE SET NULL;

-- Add constraint for valid billing types
CREATE OR REPLACE FUNCTION public.validate_billing_type()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.billing_type NOT IN ('monthly', 'per_session', 'institution') THEN
    RAISE EXCEPTION 'Invalid billing_type: %', NEW.billing_type;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER check_billing_type
BEFORE INSERT OR UPDATE ON public.patients
FOR EACH ROW
EXECUTE FUNCTION public.validate_billing_type();

-- Index for parent-child lookups
CREATE INDEX idx_patients_parent ON public.patients(parent_patient_id) WHERE parent_patient_id IS NOT NULL;
