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
//   summarized     + not paid              -> "5" (banana / yellow)
//   not summarized + not paid              -> default (no colorId)
//   not summarized + paid                  -> "6" (tangerine / orange)
//   summarized     + paid + not invoiced   -> "7" (peacock)
//   summarized     + paid + invoiced       -> "3" (grape / purple)
// Cancelled events ("4" / flamingo) are left untouched.
export const CANCELLED_COLOR_ID = "4";
export const SUMMARIZED_UNPAID_COLOR_ID = "5";
export const PAID_UNSUMMARIZED_COLOR_ID = "6";
export const SUMMARIZED_PAID_UNINVOICED_COLOR_ID = "7";
export const COMPLETE_COLOR_ID = "3";

export type EventStatus = {
  summarized: boolean;
  paid: boolean;
  invoiced?: boolean;
};

export const statusFromCalendarColor = (
  colorId?: string | null,
): Partial<Required<EventStatus>> => {
  if (colorId === SUMMARIZED_UNPAID_COLOR_ID) {
    return { summarized: true };
  }
  if (colorId === PAID_UNSUMMARIZED_COLOR_ID) {
    return { paid: true };
  }
  if (colorId === SUMMARIZED_PAID_UNINVOICED_COLOR_ID) {
    return { summarized: true, paid: true };
  }
  if (colorId === COMPLETE_COLOR_ID) {
    return { summarized: true, paid: true, invoiced: true };
  }
  return {};
};

export const deriveEventStatus = ({
  colorId,
  summarizedInDb,
  paidInDb,
  invoicedInDb,
}: {
  colorId?: string | null;
  summarizedInDb: boolean;
  paidInDb: boolean;
  invoicedInDb: boolean;
}): Required<EventStatus> => {
  const fromColor = statusFromCalendarColor(colorId);
  return {
    summarized: summarizedInDb || fromColor.summarized === true,
    paid: paidInDb || fromColor.paid === true,
    invoiced: invoicedInDb || fromColor.invoiced === true,
  };
};

export const computeTargetColorId = (s: EventStatus): string | null => {
  if (s.summarized && s.paid && s.invoiced) return COMPLETE_COLOR_ID;
  if (s.summarized && s.paid) return SUMMARIZED_PAID_UNINVOICED_COLOR_ID;
  if (!s.summarized && s.paid) return PAID_UNSUMMARIZED_COLOR_ID;
  if (s.summarized && !s.paid) return SUMMARIZED_UNPAID_COLOR_ID;
  return null; // nothing done -> default
};
