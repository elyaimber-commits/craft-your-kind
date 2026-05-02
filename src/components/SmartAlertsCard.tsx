import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bell, AlertTriangle, Clock, CheckCircle2 } from "lucide-react";
import { useMemo } from "react";

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  colorId?: string;
}

const BILLING_COLOR_IDS = ["5", "3", "6", "7"];
const isBillingEvent = (colorId?: string) => !colorId || BILLING_COLOR_IDS.includes(colorId);

const normalizeName = (name: string): string =>
  name
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/(.)\1+/g, "$1");

interface Patient {
  id: string;
  name: string;
}

const SmartAlertsCard = ({ patients }: { patients: Patient[] }) => {
  const { user } = useAuth();

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Reuse the cache from MonthlyBillingSummary
  const { data: calendarData } = useQuery({
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

  // Prior months unpaid debt
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
      const { data, error } = await supabase.from("event_aliases").select("*");
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  const { data: ignoredEvents = [] } = useQuery({
    queryKey: ["ignored-calendar-events"],
    queryFn: async () => {
      const { data, error } = await supabase.from("ignored_calendar_events").select("*");
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  const alerts = useMemo(() => {
    const events = calendarData?.events || [];
    const aliasMap = new Map<string, string>();
    for (const a of aliases) aliasMap.set(normalizeName(a.event_name), a.patient_id);
    const ignoredSet = new Set(ignoredEvents.map((e: any) => normalizeName(e.event_name)));

    const findPatient = (name: string): Patient | null => {
      const norm = normalizeName(name);
      for (const p of patients) if (normalizeName(p.name) === norm) return p;
      const aliasId = aliasMap.get(norm);
      if (aliasId) return patients.find((p) => p.id === aliasId) || null;
      return null;
    };

    // 1. Past events not billed (in current month)
    const pastUnbilled: { name: string; date: Date }[] = [];
    let unmatchedCount = 0;
    for (const ev of events) {
      if (!isBillingEvent(ev.colorId)) continue;
      if (!ev.summary) continue;
      if (ignoredSet.has(normalizeName(ev.summary))) continue;
      const startStr = ev.start.dateTime || ev.start.date;
      if (!startStr) continue;
      const startDate = new Date(startStr);
      if (startDate >= now) continue;
      const matched = findPatient(ev.summary);
      if (!matched) {
        unmatchedCount++;
        continue;
      }
      // Check if this event is paid in any payment
      const isPaid = payments.some((p: any) => (p.paid_event_ids || []).includes(ev.id));
      if (!isPaid) pastUnbilled.push({ name: matched.name, date: startDate });
    }

    // 2. Accumulated debt from prior months (per patient)
    const debtByPatient = new Map<string, number>();
    for (const p of priorDebts as any[]) {
      const total = Number(p.total_billed || 0);
      const paid = Number(p.amount || 0);
      const debt = total - paid;
      if (debt > 0) {
        debtByPatient.set(p.patient_id, (debtByPatient.get(p.patient_id) || 0) + debt);
      }
    }
    const debtors = Array.from(debtByPatient.entries())
      .map(([id, amount]) => ({
        patient: patients.find((p) => p.id === id),
        amount,
      }))
      .filter((d) => d.patient && d.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    const totalDebt = debtors.reduce((s, d) => s + d.amount, 0);

    return {
      pastUnbilled,
      unmatchedCount,
      debtors,
      totalDebt,
    };
  }, [calendarData, payments, priorDebts, aliases, ignoredEvents, patients, now]);

  const hasAnyAlert =
    alerts.pastUnbilled.length > 0 || alerts.unmatchedCount > 0 || alerts.debtors.length > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Bell className="h-5 w-5 text-primary" />
          דורש תשומת לב
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasAnyAlert ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            הכל מסודר! אין התראות פתוחות.
          </div>
        ) : (
          <>
            {alerts.debtors.length > 0 && (
              <AlertRow
                icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
                title={`חוב מצטבר מחודשים קודמים: ₪${alerts.totalDebt.toLocaleString("he-IL")}`}
                detail={`${alerts.debtors.length} מטופלים — ${alerts.debtors
                  .slice(0, 3)
                  .map((d) => `${d.patient!.name} (₪${Math.round(d.amount).toLocaleString("he-IL")})`)
                  .join(", ")}${alerts.debtors.length > 3 ? "..." : ""}`}
              />
            )}
            {alerts.pastUnbilled.length > 0 && (
              <AlertRow
                icon={<Clock className="h-4 w-4 text-orange-500" />}
                title={`${alerts.pastUnbilled.length} פגישות שעברו ולא חויבו החודש`}
                detail={alerts.pastUnbilled
                  .slice(0, 4)
                  .map((p) => p.name)
                  .join(", ") + (alerts.pastUnbilled.length > 4 ? "..." : "")}
              />
            )}
            {alerts.unmatchedCount > 0 && (
              <AlertRow
                icon={<AlertTriangle className="h-4 w-4 text-yellow-600" />}
                title={`${alerts.unmatchedCount} אירועי יומן ללא התאמה למטופל`}
                detail="גלול לסיכום החודשי כדי לשייך או להתעלם"
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};

const AlertRow = ({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
}) => (
  <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3">
    <div className="mt-0.5">{icon}</div>
    <div className="flex-1 min-w-0">
      <p className="text-sm font-medium">{title}</p>
      {detail && <p className="text-xs text-muted-foreground mt-0.5 truncate">{detail}</p>}
    </div>
  </div>
);

export default SmartAlertsCard;
