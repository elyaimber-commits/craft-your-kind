// Shared helpers for matching calendar events to patients.

export interface PatientLite {
  id: string;
  name: string;
  billing_type?: string;
  parent_patient_id?: string | null;
}

/** Normalize a name for matching */
export const normalizeName = (name: string): string =>
  name
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/(.)\1+/g, "$1");

/** Find matching patient: exact first, then check aliases */
export const findMatchingPatient = <P extends PatientLite>(
  eventName: string,
  patients: P[],
  aliasMap: Map<string, string>,
): { patient: P; viaAlias: boolean } | null => {
  const normalizedEvent = normalizeName(eventName);
  for (const patient of patients) {
    if (normalizeName(patient.name) === normalizedEvent) {
      return { patient, viaAlias: false };
    }
  }
  const aliasPatientId = aliasMap.get(normalizedEvent);
  if (aliasPatientId) {
    const patient = patients.find((p) => p.id === aliasPatientId);
    if (patient) return { patient, viaAlias: true };
  }
  return null;
};

// ===== Color logic =====
// Status combinations and their target Google Calendar color IDs:
//   summarized     + not paid -> "5"  (banana / yellow)   <-- session held & summarized, awaiting payment
//   not summarized + not paid -> default (no colorId)     <-- nothing done yet
//   not summarized + paid     -> "6"  (tangerine / orange)
//   summarized     + paid     -> "3"  (grape / purple)
// Cancelled events ("4" / flamingo) are left untouched.
export const CANCELLED_COLOR_ID = "4";

export type EventStatus = {
  summarized: boolean;
  paid: boolean;
};

export const computeTargetColorId = (s: EventStatus): string | null => {
  if (s.summarized && s.paid) return "3";
  if (!s.summarized && s.paid) return "6";
  if (s.summarized && !s.paid) return "5"; // summarized, awaiting payment -> yellow
  return null; // nothing done -> default
};
