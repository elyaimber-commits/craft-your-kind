import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar, ChevronRight, ChevronLeft, Search, ChevronDown, ChevronUp } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import { useState, useEffect, useRef } from "react";
import PatientBillingCard from "@/components/PatientBillingCard";
import EventAliasSuggestion from "@/components/EventAliasSuggestion";
import IgnoredEventsManager from "@/components/IgnoredEventsManager";
import MindMeExport from "@/components/MindMeExport";

interface Patient {
  id: string;
  name: string;
  phone: string;
  session_price: number;
  billing_type?: string;
  parent_patient_id?: string | null;
  mindme?: boolean;
  manual_debt?: number;
  manual_debt_note?: string | null;
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

// Google Calendar color IDs:
// default (undefined) = needs billing, session summary not written
// "5" (banana/yellow) = needs billing, session summary done
// "4" (flamingo/red) = cancelled, no billing
// "3" (grape/purple) = paid
const BILLING_COLOR_IDS = ["5", "3"]; // Banana (unpaid) + Grape (paid)
const isBillingEvent = (colorId?: string) => !colorId || BILLING_COLOR_IDS.includes(colorId);
const CANCELLED_COLOR_ID = "4";

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
  const [searchQuery, setSearchQuery] = useState("");
  const [debtExpanded, setDebtExpanded] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "paid" | "unpaid" | "partial">("all");
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

  // Fetch prior months' payments to calculate carried-over debt
  const { data: priorDebts = [] } = useQuery({
    queryKey: ["payments-prior-debts", currentMonth],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("id, patient_id, amount, total_billed, month")
        .lt("month", currentMonth)
        .not("total_billed", "is", null);
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

  const { data: sessionOverrides = [] } = useQuery({
    queryKey: ["session-overrides"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("session_overrides")
        .select("*");
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  // Build override map: event_id -> custom_price
  const overrideMap = new Map<string, number>();
  sessionOverrides.forEach((o: any) => {
    overrideMap.set(o.event_id, Number(o.custom_price));
  });

  // Build alias map: normalized event name -> patient_id
  const aliasMap = new Map<string, string>();
  aliases.forEach((a: any) => {
    aliasMap.set(normalizeName(a.event_name), a.patient_id);
  });

  // Build ignored set
  const ignoredSet = new Set(ignoredEvents.map((e: any) => normalizeName(e.event_name)));

  const events = calendarData?.events || [];
  const billingEvents = events.filter((e) => isBillingEvent(e.colorId) && e.colorId !== CANCELLED_COLOR_ID);
  const allEvents = events;
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
            sessionPrice: overrideMap.has(event.id) ? overrideMap.get(event.id)! : matchedPatient.session_price,
          };
        });

      // Calculate total using per-session prices (handles institution children with different prices)
      const total = matchingSessions.reduce((sum, session) => sum + (session.sessionPrice ?? patient.session_price), 0);

      return {
        patient,
        sessions: matchingSessions,
        total,
        childPatients: patient.billing_type === "institution" ? (childPatientsByParent.get(patient.id) || []) : [],
      };
    })
    .filter((b) => b.sessions.length > 0)
    .sort((a, b) => b.total - a.total);

  // === Auto-sync: save total_billed + purple calendar events → paid status in DB ===
  useEffect(() => {
    if (!user || !calendarData?.events || syncedMonthsRef.current.has(currentMonth)) return;
    
    const syncPayments = async () => {
      for (const billing of billingData) {
        const existingPayment = payments.find((p) => p.patient_id === billing.patient.id);

        // Find purple (paid) sessions
        const purpleSessions = billing.sessions.filter((s) => {
          const event = events.find((e) => e.id === s.eventId);
          return event?.colorId === "3" && s.eventId;
        });

        const existingPaidIds = new Set((existingPayment as any)?.paid_event_ids || []);
        const allPaidIds = [...new Set([
          ...Array.from(existingPaidIds),
          ...purpleSessions.map(s => s.eventId!),
        ])] as string[];

        const sessionsPaidAmount = billing.sessions
          .filter(s => s.eventId && allPaidIds.includes(s.eventId))
          .reduce((sum, s) => sum + (s.sessionPrice ?? billing.patient.session_price), 0);

        // Preserve any "extra" partial payment beyond what sessions cover
        const previousAmount = (existingPayment as any)?.amount ?? 0;
        const previousSessionsAmount = billing.sessions
          .filter(s => s.eventId && existingPaidIds.has(s.eventId))
          .reduce((sum, s) => sum + (s.sessionPrice ?? billing.patient.session_price), 0);
        const extraPaid = Math.max(0, previousAmount - previousSessionsAmount);
        const paidAmount = sessionsPaidAmount + extraPaid;

        const allPaid = paidAmount >= billing.total;

        if (existingPayment) {
          // Update total_billed + paid info
          const needsUpdate =
            (existingPayment as any).total_billed !== billing.total ||
            allPaidIds.length !== existingPaidIds.size;
          if (needsUpdate) {
            await supabase
              .from("payments")
              .update({
                total_billed: billing.total,
                paid: allPaid,
                paid_at: allPaidIds.length > 0 || extraPaid > 0 ? new Date().toISOString() : existingPayment.paid_at,
                amount: paidAmount,
                session_count: allPaidIds.length,
                paid_event_ids: allPaidIds,
              })
              .eq("id", existingPayment.id);
          }
        } else {
          // Create new payment record with total_billed
          await supabase.from("payments").insert({
            therapist_id: user.id,
            patient_id: billing.patient.id,
            month: currentMonth,
            amount: paidAmount,
            total_billed: billing.total,
            session_count: allPaidIds.length,
            paid: allPaid,
            paid_at: allPaidIds.length > 0 ? new Date().toISOString() : null,
            paid_event_ids: allPaidIds,
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
    const message = `היי, מעדכן לגבי החודש.\nמפגשים: ${dates}\nסה״כ: ₪${billing.total}\nתודה!`;
    const cleanPhone = billing.patient.phone.replace(/\D/g, "");
    const intlPhone = cleanPhone.startsWith("0") ? "972" + cleanPhone.slice(1) : cleanPhone;
    return `https://wa.me/${intlPhone}?text=${encodeURIComponent(message)}`;
  };

  // MindMe toggle
  const toggleMindMe = async (patientId: string, currentValue: boolean) => {
    await supabase.from("patients").update({ mindme: !currentValue }).eq("id", patientId);
    queryClient.invalidateQueries({ queryKey: ["patients"] });
  };

  // Compute payment status per billing entry
  const getPatientStatus = (b: typeof billingData[number]): "paid" | "unpaid" | "partial" => {
    const payment = payments.find((p) => p.patient_id === b.patient.id);
    const paidIds = (payment as any)?.paid_event_ids || [];
    const sessionsPaid = b.sessions
      .filter((s) => s.eventId && paidIds.includes(s.eventId))
      .reduce((sum, s) => sum + (s.sessionPrice ?? b.patient.session_price), 0);
    const totalPaid = Math.max(sessionsPaid, payment?.amount ?? 0);
    if (totalPaid <= 0) return "unpaid";
    if (totalPaid >= b.total) return "paid";
    return "partial";
  };

  // Filter billing data by search query and status
  const filteredBillingData = billingData
    .filter((b) => (searchQuery.trim() ? b.patient.name.includes(searchQuery.trim()) : true))
    .filter((b) => (statusFilter === "all" ? true : getPatientStatus(b) === statusFilter));

  // Counts per status (based on search-filtered data, before status filter)
  const searchOnlyData = searchQuery.trim()
    ? billingData.filter((b) => b.patient.name.includes(searchQuery.trim()))
    : billingData;
  const statusCounts = {
    all: searchOnlyData.length,
    paid: searchOnlyData.filter((b) => getPatientStatus(b) === "paid").length,
    unpaid: searchOnlyData.filter((b) => getPatientStatus(b) === "unpaid").length,
    partial: searchOnlyData.filter((b) => getPatientStatus(b) === "partial").length,
  };

  // MindMe commission calculations
  const mindMePatients = filteredBillingData.filter(b => b.patient.mindme === true);
  const mindMeCommissions = mindMePatients.map(b => ({
    name: b.patient.name,
    total: b.total,
    commission: Math.round(b.total * 0.3),
  }));
  const totalMindMeCommission = mindMeCommissions.reduce((sum, c) => sum + c.commission, 0);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-muted-foreground">
          טוען סיכום חודשי...
        </CardContent>
      </Card>
    );
  }

  const totalBilled = filteredBillingData.reduce((sum, b) => sum + b.total, 0);
  const totalPaid = filteredBillingData.reduce((sum, b) => {
    const payment = payments.find((p) => p.patient_id === b.patient.id);
    const paidIds = (payment as any)?.paid_event_ids || [];
    return sum + b.sessions
      .filter(s => s.eventId && paidIds.includes(s.eventId))
      .reduce((s, session) => s + (session.sessionPrice ?? b.patient.session_price), 0);
  }, 0);

  // Calculate carried-over debt from prior months (with per-month breakdown)
  const priorDebtByPatient = new Map<string, number>();
  const priorDebtDetailByPatient = new Map<string, { month: string; debt: number; paymentId?: string }[]>();
  priorDebts.forEach((p: any) => {
    const debt = (p.total_billed || 0) - (p.amount || 0);
    if (debt > 0) {
      priorDebtByPatient.set(p.patient_id, (priorDebtByPatient.get(p.patient_id) || 0) + debt);
      const details = priorDebtDetailByPatient.get(p.patient_id) || [];
      details.push({ month: p.month, debt, paymentId: p.id });
      priorDebtDetailByPatient.set(p.patient_id, details);
    }
  });

  // Add manual debts (one-off, manually entered debts e.g. from previous years)
  const manualDebtByPatient = new Map<string, { amount: number; note?: string | null }>();
  patients.forEach((p) => {
    const md = Number(p.manual_debt || 0);
    if (md > 0) {
      manualDebtByPatient.set(p.id, { amount: md, note: p.manual_debt_note });
      priorDebtByPatient.set(p.id, (priorDebtByPatient.get(p.id) || 0) + md);
    }
  });

  const totalPriorDebt = filteredBillingData.reduce((sum, b) => {
    return sum + (priorDebtByPatient.get(b.patient.id) || 0);
  }, 0);
  // Also include prior debt for patients not in current month billing
  const allPriorDebt = Array.from(priorDebtByPatient.values()).reduce((sum, d) => sum + d, 0);
  const currentMonthRemaining = totalBilled - totalPaid;
  const totalRemaining = currentMonthRemaining + allPriorDebt;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between flex-wrap gap-2">
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
        </CardTitle>
        {billingData.length > 0 && (
          <div className="text-sm font-normal text-muted-foreground space-y-1 mt-2">
            <div>שולם: ₪{totalPaid} / ₪{totalBilled} · נותר החודש: ₪{currentMonthRemaining}</div>
            {allPriorDebt > 0 && (
              <Collapsible open={debtExpanded} onOpenChange={setDebtExpanded}>
                <CollapsibleTrigger className="text-destructive font-medium flex items-center gap-1.5 hover:underline cursor-pointer w-full text-right">
                  <span>חוב מצטבר מחודשים קודמים: ₪{allPriorDebt} · סה״כ נותר: ₪{totalRemaining}</span>
                  {debtExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 bg-destructive/5 rounded-lg p-3 space-y-1">
                  {Array.from(priorDebtByPatient.entries())
                    .sort((a, b) => b[1] - a[1])
                    .map(([patientId, debt]) => {
                      const patient = patients.find(p => p.id === patientId);
                      const details = priorDebtDetailByPatient.get(patientId) || [];
                      const manual = manualDebtByPatient.get(patientId);
                      const formatML = (m: string) => {
                        const [y, mo] = m.split("-");
                        const d = new Date(parseInt(y), parseInt(mo) - 1);
                        return d.toLocaleDateString("he-IL", { month: "long", year: "numeric" });
                      };
                      const parts: string[] = details.map(d => `${formatML(d.month)}: ₪${d.debt}`);
                      if (manual) {
                        parts.push(`ידני${manual.note ? ` (${manual.note})` : ""}: ₪${manual.amount}`);
                      }
                      return (
                        <div key={patientId} className="flex items-center justify-between text-xs py-1 border-b border-border/50 last:border-0 gap-2">
                          <span className="font-medium">{patient?.name || "לא ידוע"}</span>
                          <div className="flex items-center gap-2 flex-wrap justify-end">
                            <span className="text-muted-foreground">
                              {parts.join(" · ")}
                            </span>
                            <span className="font-bold text-destructive">₪{debt}</span>
                          </div>
                        </div>
                      );
                    })}
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        {billingData.length > 0 && (
          <div className="space-y-3 mb-4">
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="חיפוש מטופל..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pr-9"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {([
                { key: "all", label: "הכל" },
                { key: "unpaid", label: "לא שולם" },
                { key: "partial", label: "חלקי" },
                { key: "paid", label: "שולם" },
              ] as const).map((opt) => (
                <Button
                  key={opt.key}
                  size="sm"
                  variant={statusFilter === opt.key ? "default" : "outline"}
                  onClick={() => setStatusFilter(opt.key)}
                  className="h-8"
                >
                  {opt.label}
                  <span className="mr-1.5 text-xs opacity-70">({statusCounts[opt.key]})</span>
                </Button>
              ))}
            </div>
          </div>
        )}
        {filteredBillingData.length === 0 && filteredUnmatched.length === 0 ? (
          <p className="text-muted-foreground text-center py-4">
            אין פגישות שסומנו כ"בוצע" (צהוב) החודש
          </p>
        ) : (
          <div className="space-y-3">
            {filteredBillingData.map((billing) => {
              const patientPriorDebt = priorDebtByPatient.get(billing.patient.id) || 0;
              const patientDebtDetails = priorDebtDetailByPatient.get(billing.patient.id) || [];
              const formatMonthLabel = (m: string) => {
                const [y, mo] = m.split("-");
                const d = new Date(parseInt(y), parseInt(mo) - 1);
                return d.toLocaleDateString("he-IL", { month: "long", year: "numeric" });
              };
              return (
                <div key={billing.patient.id}>
                  <div className="flex items-center gap-2 mb-1">
                    {patientPriorDebt > 0 && (() => {
                      const manual = manualDebtByPatient.get(billing.patient.id);
                      const parts: string[] = patientDebtDetails.map(d => `${formatMonthLabel(d.month)}: ₪${d.debt}`);
                      if (manual) parts.push(`ידני${manual.note ? ` (${manual.note})` : ""}: ₪${manual.amount}`);
                      return (
                        <div className="text-xs text-destructive font-medium pr-2">
                          חוב מחודשים קודמים: ₪{patientPriorDebt}
                          <span className="text-muted-foreground font-normal mr-2">
                            ({parts.join(" · ")})
                          </span>
                        </div>
                      );
                    })()}
                    <div className="flex items-center gap-1.5 mr-auto" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        id={`mindme-${billing.patient.id}`}
                       checked={billing.patient.mindme === true}
                       onCheckedChange={() => toggleMindMe(billing.patient.id, !!billing.patient.mindme)}
                        className="h-4 w-4"
                      />
                      <label htmlFor={`mindme-${billing.patient.id}`} className="text-xs text-muted-foreground cursor-pointer select-none">
                        MindMe
                      </label>
                    </div>
                  </div>
                  <PatientBillingCard
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
                    priorDebtDetails={patientDebtDetails}
                  />
                </div>
              );
            })}

            {/* MindMe Commission Summary */}
            {mindMeCommissions.length > 0 && (
              <div className="pt-3 border-t">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold">עמלת MindMe (30%)</h3>
                  <MindMeExport />
                </div>
                <div className="rounded-lg border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50">
                        <th className="text-right py-2 px-3 font-medium">מטופל</th>
                        <th className="text-left py-2 px-3 font-medium">ברוטו</th>
                        <th className="text-left py-2 px-3 font-medium">עמלה (30%)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mindMeCommissions.map((c) => (
                        <tr key={c.name} className="border-t border-border/50">
                          <td className="py-2 px-3">{c.name}</td>
                          <td className="py-2 px-3 font-mono text-left">₪{c.total}</td>
                          <td className="py-2 px-3 font-mono text-left font-medium">₪{c.commission}</td>
                        </tr>
                      ))}
                      <tr className="border-t bg-muted/30 font-bold">
                        <td className="py-2 px-3">סה״כ</td>
                        <td className="py-2 px-3 font-mono text-left">₪{mindMePatients.reduce((s, b) => s + b.total, 0)}</td>
                        <td className="py-2 px-3 font-mono text-left text-primary">₪{totalMindMeCommission}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

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

            <IgnoredEventsManager ignoredEvents={ignoredEvents} />
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default MonthlyBillingSummary;
