import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar, MessageCircle, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

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
}

interface PatientBilling {
  patient: Patient;
  sessions: { date: string; summary: string }[];
  total: number;
}

interface MonthlyBillingSummaryProps {
  patients: Patient[];
}

const YELLOW_COLOR_IDS = ["5"]; // Yellow = completed session

const MonthlyBillingSummary = ({ patients }: MonthlyBillingSummaryProps) => {
  const { user } = useAuth();
  const [expandedPatient, setExpandedPatient] = useState<string | null>(null);

  // Get current month range
  const now = new Date();
  const currentMonthName = now.toLocaleDateString("he-IL", { month: "long", year: "numeric" });

  const { data: calendarData, isLoading } = useQuery({
    queryKey: ["google-calendar-events-billing"],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const res = await supabase.functions.invoke("google-calendar-billing", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (res.error) throw res.error;
      return res.data as { events?: CalendarEvent[]; error?: string };
    },
    enabled: !!user,
  });

  const events = calendarData?.events || [];

  // Match yellow events to patients by name
  const yellowEvents = events.filter((e) => YELLOW_COLOR_IDS.includes(e.colorId || ""));

  const billingData: PatientBilling[] = patients
    .map((patient) => {
      const matchingSessions = yellowEvents
        .filter((event) => {
          const eventName = (event.summary || "").trim().toLowerCase();
          const patientName = patient.name.trim().toLowerCase();
          return eventName.includes(patientName) || patientName.includes(eventName);
        })
        .map((event) => ({
          date: event.start.dateTime
            ? new Date(event.start.dateTime).toLocaleDateString("he-IL", {
                day: "numeric",
                month: "short",
              })
            : event.start.date
            ? new Date(event.start.date).toLocaleDateString("he-IL", {
                day: "numeric",
                month: "short",
              })
            : "",
          summary: event.summary || "",
        }));

      return {
        patient,
        sessions: matchingSessions,
        total: matchingSessions.length * patient.session_price,
      };
    })
    .filter((b) => b.sessions.length > 0)
    .sort((a, b) => b.total - a.total);

  const generateWhatsAppMessage = (billing: PatientBilling) => {
    const dates = billing.sessions.map((s) => s.date).join(", ");
    const message = `היי ${billing.patient.name}, מעדכן לגבי החודש.\nמפגשים: ${dates}\nסה״כ: ₪${billing.total}\nתודה! 🙏`;
    const cleanPhone = billing.patient.phone.replace(/\D/g, "");
    const intlPhone = cleanPhone.startsWith("0") ? "972" + cleanPhone.slice(1) : cleanPhone;
    return `https://wa.me/${intlPhone}?text=${encodeURIComponent(message)}`;
  };

  if (calendarData?.error === "not_connected") {
    return null; // GoogleCalendarSection handles this
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-muted-foreground">
          טוען סיכום חודשי...
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          סיכום חיוב — {currentMonthName}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {billingData.length === 0 ? (
          <p className="text-muted-foreground text-center py-4">
            אין פגישות שסומנו כ"בוצע" (צהוב) החודש
          </p>
        ) : (
          <div className="space-y-3">
            {billingData.map((billing) => {
              const isExpanded = expandedPatient === billing.patient.id;
              return (
                <div
                  key={billing.patient.id}
                  className="rounded-lg border bg-card"
                >
                  <div
                    className="flex items-center justify-between p-4 cursor-pointer hover:bg-accent/50 transition-colors rounded-lg"
                    onClick={() =>
                      setExpandedPatient(isExpanded ? null : billing.patient.id)
                    }
                  >
                    <div className="flex items-center gap-3">
                      <button className="text-muted-foreground">
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </button>
                      <div>
                        <span className="font-semibold text-lg">
                          {billing.patient.name}
                        </span>
                        <span className="text-sm text-muted-foreground mr-2">
                          ({billing.sessions.length} פגישות)
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-bold text-lg">
                        ₪{billing.total}
                      </span>
                      <Button
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(
                            generateWhatsAppMessage(billing),
                            "_blank"
                          );
                        }}
                      >
                        <MessageCircle className="ml-1 h-4 w-4" />
                        שלח בקשת תשלום
                      </Button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-0 border-t">
                      <div className="mt-3 space-y-1">
                        {billing.sessions.map((session, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between text-sm py-1 px-2 rounded bg-yellow-50 border-r-4 border-r-yellow-500"
                          >
                            <span>{session.summary}</span>
                            <span className="text-muted-foreground" dir="ltr">
                              {session.date}
                            </span>
                          </div>
                        ))}
                        <div className="flex justify-between pt-2 font-medium border-t mt-2">
                          <span>
                            {billing.sessions.length} × ₪
                            {billing.patient.session_price}
                          </span>
                          <span>סה״כ: ₪{billing.total}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default MonthlyBillingSummary;
