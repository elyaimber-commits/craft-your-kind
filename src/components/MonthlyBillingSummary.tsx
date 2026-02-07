import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar, ChevronRight, ChevronLeft } from "lucide-react";
import { useState } from "react";
import NewPatientSuggestion from "@/components/NewPatientSuggestion";
import PatientBillingCard from "@/components/PatientBillingCard";

interface Patient {
  id: string;
  name: string;
  phone: string;
  session_price: number;
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

const MonthlyBillingSummary = ({ patients }: MonthlyBillingSummaryProps) => {
  const { user } = useAuth();
  const [expandedPatient, setExpandedPatient] = useState<string | null>(null);
  const [monthOffset, setMonthOffset] = useState(0);

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

  const events = calendarData?.events || [];
  const yellowEvents = events.filter((e) => YELLOW_COLOR_IDS.includes(e.colorId || ""));
  const matchedEventIds = new Set<string>();

  const billingData = patients
    .map((patient) => {
      const matchingSessions = yellowEvents
        .filter((event) => {
          const eventName = (event.summary || "").trim().toLowerCase();
          const patientName = patient.name.trim().toLowerCase();
          return eventName === patientName;
        })
        .map((event) => {
          matchedEventIds.add(event.id);
          return {
            date: event.start.dateTime
              ? (() => { const d = new Date(event.start.dateTime!); return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`; })()
              : event.start.date
              ? (() => { const d = new Date(event.start.date!); return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`; })()
              : "",
            summary: event.summary || "",
            eventId: event.id,
            calendarId: event.organizer?.email || "primary",
          };
        });

      return {
        patient,
        sessions: matchingSessions,
        total: matchingSessions.length * patient.session_price,
      };
    })
    .filter((b) => b.sessions.length > 0)
    .sort((a, b) => b.total - a.total);

  const unmatchedEvents = yellowEvents.filter((e) => !matchedEventIds.has(e.id));
  const unmatchedByName: Record<string, number> = {};
  unmatchedEvents.forEach((e) => {
    const name = (e.summary || "").trim();
    if (name) {
      unmatchedByName[name] = (unmatchedByName[name] || 0) + 1;
    }
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
            <Button variant="ghost" size="icon" onClick={() => setMonthOffset(o => o - 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-[100px] text-center">{currentMonthName}</span>
            <Button variant="ghost" size="icon" onClick={() => setMonthOffset(o => o + 1)} disabled={monthOffset >= 0}>
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
        {billingData.length === 0 && Object.keys(unmatchedByName).length === 0 ? (
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
              />
            ))}

            {Object.keys(unmatchedByName).length > 0 && (
              <div className="space-y-2 pt-2 border-t">
                <h3 className="text-sm font-medium text-muted-foreground">
                  מטופלים חדשים שזוהו ביומן:
                </h3>
                {Object.entries(unmatchedByName).map(([name, count]) => (
                  <NewPatientSuggestion key={name} name={name} sessionCount={count} />
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
