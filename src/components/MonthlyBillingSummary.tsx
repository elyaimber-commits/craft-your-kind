import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar, ChevronRight, ChevronLeft } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import PatientBillingCard from "@/components/PatientBillingCard";
import EventAliasSuggestion from "@/components/EventAliasSuggestion";

interface Patient {
  id: string;
  name: string;
  phone: string;
  session_price: number;
  billing_type?: string;
  parent_patient_id?: string | null;
}

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  colorId?: string;
  calendarName?: string;
  organizer?: { email?: string };
}

interface MonthlyBillingSummaryProps {
  patients: Patient[];
}

const YELLOW_COLOR_IDS = ["5"];
const BILLING_COLOR_IDS = ["5", "3"]; // Yellow (unpaid) + Purple/Grape (paid)

/** Normalize a name for matching: trim, collapse whitespace, lowercase, strip diacritics, collapse duplicate Hebrew letters */
const normalizeName = (name: string): string =>
  name
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, "") // strip Hebrew diacritics (nikud)
    .replace(/(.)\1+/g, "$1"); // collapse duplicate consecutive characters

/** Find matching patient: exact first, then check aliases. Returns patient + whether it was via alias */
const findMatchingPatient = (
  eventName: string,
  patients: Patient[],
  aliasMap: Map<string, string> // normalized event name -> patient id
): { patient: Patient; viaAlias: boolean } | null => {
  const normalizedEvent = normalizeName(eventName);

  // Priority 1: Exact match after normalization
  for (const patient of patients) {
    if (normalizeName(patient.name) === normalizedEvent) return { patient, viaAlias: false };
  }

  // Priority 2: Check saved aliases
  const aliasPatientId = aliasMap.get(normalizedEvent);
  if (aliasPatientId) {
    const patient = patients.find((p) => p.id === aliasPatientId);
    if (patient) return { patient, viaAlias: true };
  }

  return null;
};

/** Find patients that partially match an event name (for suggestions) */
const findPartialMatches = (eventName: string, patients: Patient[]): Patient[] => {
  const normalizedEvent = normalizeName(eventName);
  if (normalizedEvent.length < 2) return [];

  return patients.filter((patient) => {
    const normalizedPatient = normalizeName(patient.name);
    // Check if either contains the other, or shares a word
    const eventWords = normalizedEvent.split(" ");
    const patientWords = normalizedPatient.split(" ");
    return (
      normalizedPatient.includes(normalizedEvent) ||
      normalizedEvent.includes(normalizedPatient) ||
      eventWords.some((w) => w.length >= 2 && patientWords.includes(w)) ||
      patientWords.some((w) => w.length >= 2 && eventWords.includes(w))
    );
  });
};

const MonthlyBillingSummary = ({ patients }: MonthlyBillingSummaryProps) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [expandedPatient, setExpandedPatient] = useState<string | null>(null);
  const [monthOffset, setMonthOffset] = useState(0);
  const syncedMonthsRef = useRef<Set<string>>(new Set());

  const selectedDate = new Date();
  selectedDate.setMonth(selectedDate.getMonth() + monthOffset);
  const currentMonth = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, "0")}`;
  const currentMonthName = selectedDate.toLocaleDateString("he-IL", { month: "long", year: "numeric" });

  const { data: calendarData, isLoading } = useQuery({
    queryKey: ["google-calendar-events-billing", currentMonth],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const res = await supabase.functions.invoke("google-calendar-billing", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { month: currentMonth },
      });
      if (res.error) throw res.error;
      return res.data as { events?: CalendarEvent[]; error?: string };
    },
    enabled: !!user,
  });

  const { data: payments = [] } = useQuery({
    queryKey: ["payments", currentMonth],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("*")
        .eq("month", currentMonth);
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  const { data: aliases = [] } = useQuery({
    queryKey: ["event-aliases"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("event_aliases")
        .select("*");
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  const { data: ignoredEvents = [] } = useQuery({
    queryKey: ["ignored-calendar-events"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ignored_calendar_events")
        .select("event_name");
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  // Build alias map: normalized event name -> patient_id
  const aliasMap = new Map<string, string>();
  aliases.forEach((a: any) => {
    aliasMap.set(normalizeName(a.event_name), a.patient_id);
  });

  // Build ignored set
  const ignoredSet = new Set(ignoredEvents.map((e: any) => normalizeName(e.event_name)));

  const events = calendarData?.events || [];
  const billingEvents = events.filter((e) => BILLING_COLOR_IDS.includes(e.colorId || ""));
  const allEvents = events; // All events for showing unmatched (not just yellow)
  const matchedEventIds = new Set<string>();

  // Track calendar event names that differ from patient names (via alias)
  const calendarNameByPatient = new Map<string, string>();

  // Separate institution parents and children
  const institutionParents = patients.filter(p => p.billing_type === "institution");
  const childPatientsByParent = new Map<string, Patient[]>();
  patients.forEach(p => {
    if (p.parent_patient_id) {
      const children = childPatientsByParent.get(p.parent_patient_id) || [];
      children.push(p);
      childPatientsByParent.set(p.parent_patient_id, children);
    }
  });

  // Patients that are NOT children of an institution (they appear as standalone)
  const standalonePatients = patients.filter(p => !p.parent_patient_id || p.billing_type === "institution");

  const billingData = standalonePatients
    .map((patient) => {
      // For institution parents, gather sessions from all children too
      const patientsToMatch = patient.billing_type === "institution"
        ? [patient, ...(childPatientsByParent.get(patient.id) || [])]
        : [patient];

      const matchingSessions = billingEvents
        .filter((event) => {
          for (const p of patientsToMatch) {
            const matched = findMatchingPatient(event.summary || "", [p], aliasMap);
            if (matched?.patient.id === p.id) return true;
          }
          return false;
        })
        .map((event) => {
          matchedEventIds.add(event.id);
          // Find which patient actually matched
          let matchedPatient = patient;
          for (const p of patientsToMatch) {
            const matched = findMatchingPatient(event.summary || "", [p], aliasMap);
            if (matched?.patient.id === p.id) {
              matchedPatient = p;
              if (matched.viaAlias && event.summary) {
                calendarNameByPatient.set(p.id, event.summary.trim());
              }
              break;
            }
          }
          return {
            date: event.start.dateTime
              ? (() => { const d = new Date(event.start.dateTime!); return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`; })()
              : event.start.date
              ? (() => { const d = new Date(event.start.date!); return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`; })()
              : "",
            summary: event.summary || "",
            eventId: event.id,
            calendarId: event.organizer?.email || "primary",
            childPatientName: matchedPatient.id !== patient.id ? matchedPatient.name : undefined,
          };
        });

      return {
        patient,
        sessions: matchingSessions,
        total: matchingSessions.length * patient.session_price,
        childPatients: patient.billing_type === "institution" ? (childPatientsByParent.get(patient.id) || []) : [],
      };
    })
    .filter((b) => b.sessions.length > 0)
    .sort((a, b) => b.total - a.total);

  // === Auto-sync purple calendar events → paid status in DB ===
  useEffect(() => {
    if (!user || !calendarData?.events || syncedMonthsRef.current.has(currentMonth)) return;
    
    const purpleEventsByPatient = new Map<string, { count: number; total: number }>();
    
    billingData.forEach((billing) => {
      const purpleSessions = billing.sessions.filter((s) => {
        // Find the original event to check its colorId
        const event = events.find((e) => e.id === s.eventId);
        return event?.colorId === "3"; // purple = paid
      });
      
      if (purpleSessions.length > 0) {
        const existingPayment = payments.find((p) => p.patient_id === billing.patient.id);
        const alreadyPaid = existingPayment?.paid === true;
        
        if (!alreadyPaid) {
          purpleEventsByPatient.set(billing.patient.id, {
            count: purpleSessions.length,
            total: purpleSessions.length * billing.patient.session_price,
          });
        }
      }
    });
    
    if (purpleEventsByPatient.size === 0) {
      syncedMonthsRef.current.add(currentMonth);
      return;
    }
    
    // Auto-create/update payment records for purple events
    const syncPayments = async () => {
      for (const [patientId, info] of purpleEventsByPatient) {
        const existingPayment = payments.find((p) => p.patient_id === patientId);
        
        if (existingPayment) {
          await supabase
            .from("payments")
            .update({ paid: true, paid_at: new Date().toISOString(), amount: info.total, session_count: info.count })
            .eq("id", existingPayment.id);
        } else {
          await supabase.from("payments").insert({
            therapist_id: user.id,
            patient_id: patientId,
            month: currentMonth,
            amount: info.total,
            session_count: info.count,
            paid: true,
            paid_at: new Date().toISOString(),
          });
        }
      }
      
      syncedMonthsRef.current.add(currentMonth);
      queryClient.invalidateQueries({ queryKey: ["payments"] });
    };
    
    syncPayments();
  }, [calendarData, payments, billingData, currentMonth, user]);

  // Find unmatched billing events (yellow/purple that didn't match any patient)
  const unmatchedBillingEvents = billingEvents.filter((e) => !matchedEventIds.has(e.id));

  // Find ALL unmatched events (any color) for new patient discovery
  const allMatchedIds = new Set(matchedEventIds);
  const unmatchedAllEvents = allEvents.filter(
    (e) => !allMatchedIds.has(e.id) && (e.summary || "").trim().length > 0
  );

  // Group unmatched events by name
  const unmatchedByName: Record<string, { count: number; isBilling: boolean }> = {};
  unmatchedBillingEvents.forEach((e) => {
    const name = (e.summary || "").trim();
    if (name) {
      if (!unmatchedByName[name]) unmatchedByName[name] = { count: 0, isBilling: true };
      unmatchedByName[name].count++;
    }
  });

  // Also add non-billing unmatched events (for future patient discovery)
  unmatchedAllEvents.forEach((e) => {
    const name = (e.summary || "").trim();
    if (name && !unmatchedByName[name]) {
      // Check if this event name matches any patient (via exact or alias)
      const matched = findMatchingPatient(name, patients, aliasMap);
      if (!matched) {
        unmatchedByName[name] = { count: 0, isBilling: false };
      }
    }
    if (name && unmatchedByName[name] && !BILLING_COLOR_IDS.includes(e.colorId || "")) {
      unmatchedByName[name].count++;
    }
  });

  // Filter out event names that are already linked via alias or ignored
  const filteredUnmatched = Object.entries(unmatchedByName).filter(([name]) => {
    const matched = findMatchingPatient(name, patients, aliasMap);
    if (matched) return false;
    if (ignoredSet.has(normalizeName(name))) return false;
    return true;
  });

  const generateWhatsAppMessage = (billing: { patient: Patient; sessions: { date: string }[]; total: number }) => {
    const dates = billing.sessions.map((s) => s.date).join(", ");
    const message = `היי ${billing.patient.name}, מעדכן לגבי החודש.\nמפגשים: ${dates}\nסה״כ: ₪${billing.total}\nתודה! 🙏`;
    const cleanPhone = billing.patient.phone.replace(/\D/g, "");
    const intlPhone = cleanPhone.startsWith("0") ? "972" + cleanPhone.slice(1) : cleanPhone;
    return `https://wa.me/${intlPhone}?text=${encodeURIComponent(message)}`;
  };

  if (calendarData?.error === "not_connected") return null;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-muted-foreground">
          טוען סיכום חודשי...
        </CardContent>
      </Card>
    );
  }

  const totalBilled = billingData.reduce((sum, b) => sum + b.total, 0);
  const totalPaid = billingData
    .filter((b) => payments.find((p) => p.patient_id === b.patient.id)?.paid)
    .reduce((sum, b) => sum + b.total, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            סיכום חיוב
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setMonthOffset((o) => o - 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-[100px] text-center">{currentMonthName}</span>
            <Button variant="ghost" size="icon" onClick={() => setMonthOffset((o) => o + 1)} disabled={monthOffset >= 0}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          {billingData.length > 0 && (
            <div className="text-sm font-normal text-muted-foreground">
              שולם: ₪{totalPaid} / ₪{totalBilled}
            </div>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {billingData.length === 0 && filteredUnmatched.length === 0 ? (
          <p className="text-muted-foreground text-center py-4">
            אין פגישות שסומנו כ"בוצע" (צהוב) החודש
          </p>
        ) : (
          <div className="space-y-3">
            {billingData.map((billing) => (
              <PatientBillingCard
                key={billing.patient.id}
                billing={billing}
                payment={payments.find((p) => p.patient_id === billing.patient.id)}
                currentMonth={currentMonth}
                isExpanded={expandedPatient === billing.patient.id}
                onToggle={() =>
                  setExpandedPatient(
                    expandedPatient === billing.patient.id ? null : billing.patient.id
                  )
                }
                generateWhatsAppMessage={generateWhatsAppMessage}
                calendarEventName={calendarNameByPatient.get(billing.patient.id)}
              />
            ))}

            {filteredUnmatched.length > 0 && (
              <div className="space-y-2 pt-2 border-t">
                <h3 className="text-sm font-medium text-muted-foreground">
                  אירועים ביומן שלא שויכו למטופל:
                </h3>
                {filteredUnmatched.map(([name, info]) => (
                  <EventAliasSuggestion
                    key={name}
                    eventName={name}
                    sessionCount={info.count}
                    suggestedPatients={findPartialMatches(name, patients)}
                    allPatients={patients}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default MonthlyBillingSummary;
