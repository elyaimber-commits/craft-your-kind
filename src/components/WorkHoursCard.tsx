import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock, TrendingUp, Calendar as CalendarIcon } from "lucide-react";
import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  colorId?: string;
}

const BILLING_COLOR_IDS = ["5", "3"];
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
  session_price: number;
}

const DAY_NAMES = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'", "ש'"];

const WorkHoursCard = ({ patients }: { patients: Patient[] }) => {
  const { user } = useAuth();

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Reuse the same cache used by MonthlyBillingSummary
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

  const stats = useMemo(() => {
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

    let totalMinutes = 0;
    let totalSessions = 0;
    const byDay = new Array(7).fill(0).map(() => ({ sessions: 0, minutes: 0, revenue: 0 }));
    // Slot key = `${day}-${hour}` (day 0-6, hour 0-23)
    const slotRevenue = new Map<string, { day: number; hour: number; revenue: number; sessions: number }>();
    const weeksSet = new Set<string>();

    for (const ev of events) {
      if (!isBillingEvent(ev.colorId)) continue;
      if (!ev.summary) continue;
      if (ignoredSet.has(normalizeName(ev.summary))) continue;
      const startStr = ev.start.dateTime;
      const endStr = ev.end.dateTime;
      if (!startStr || !endStr) continue;
      const start = new Date(startStr);
      const end = new Date(endStr);
      if (start >= now) continue; // only completed sessions
      const minutes = (end.getTime() - start.getTime()) / 60000;
      if (minutes <= 0) continue;

      const patient = findPatient(ev.summary);
      const price = patient ? Number(patient.session_price || 0) : 0;

      // Use Israel timezone for day/hour
      const israelDate = new Date(start.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
      const day = israelDate.getDay();
      const hour = israelDate.getHours();

      totalMinutes += minutes;
      totalSessions += 1;
      byDay[day].sessions += 1;
      byDay[day].minutes += minutes;
      byDay[day].revenue += price;

      const key = `${day}-${hour}`;
      const existing = slotRevenue.get(key) || { day, hour, revenue: 0, sessions: 0 };
      existing.revenue += price;
      existing.sessions += 1;
      slotRevenue.set(key, existing);

      // Track weeks (ISO-ish: year + week number)
      const yearStart = new Date(israelDate.getFullYear(), 0, 1);
      const weekNum = Math.floor((israelDate.getTime() - yearStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
      weeksSet.add(`${israelDate.getFullYear()}-${weekNum}`);
    }

    const totalHours = totalMinutes / 60;
    const weekCount = Math.max(weeksSet.size, 1);
    const avgWeeklyHours = totalHours / weekCount;

    // Best slot
    let bestSlot: { day: number; hour: number; revenue: number; sessions: number } | null = null;
    for (const slot of slotRevenue.values()) {
      if (!bestSlot || slot.revenue > bestSlot.revenue) bestSlot = slot;
    }

    const dayChartData = byDay.map((d, i) => ({
      day: DAY_NAMES[i],
      hours: Math.round((d.minutes / 60) * 10) / 10,
    }));

    return {
      totalHours,
      totalSessions,
      avgWeeklyHours,
      bestSlot,
      dayChartData,
      hasData: totalSessions > 0,
    };
  }, [calendarData, aliases, ignoredEvents, patients, now]);

  if (isLoading) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Clock className="h-5 w-5 text-primary" />
          ניתוח שעות עבודה — {now.toLocaleDateString("he-IL", { month: "long", year: "numeric" })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!stats.hasData ? (
          <p className="text-sm text-muted-foreground">אין עדיין פגישות שהתקיימו החודש.</p>
        ) : (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Stat label="שעות בפועל" value={`${Math.round(stats.totalHours)}h`} sub={`${stats.totalSessions} פגישות`} />
              <Stat label="ממוצע שבועי" value={`${stats.avgWeeklyHours.toFixed(1)}h`} sub="לפי שבוע" />
              {stats.bestSlot && (
                <Stat
                  label="השעה הרווחית בשבוע"
                  value={`${DAY_NAMES[stats.bestSlot.day]} ${String(stats.bestSlot.hour).padStart(2, "0")}:00`}
                  sub={`₪${Math.round(stats.bestSlot.revenue).toLocaleString("he-IL")} (${stats.bestSlot.sessions} פגישות)`}
                  icon={<TrendingUp className="h-3.5 w-3.5 text-green-600" />}
                />
              )}
            </div>

            {/* Day distribution chart */}
            <div>
              <div className="flex items-center gap-2 text-sm font-medium mb-2">
                <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                התפלגות לפי יום בשבוע
              </div>
              <div className="h-[160px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.dayChartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                    <XAxis dataKey="day" fontSize={12} />
                    <YAxis fontSize={11} tickFormatter={(v) => `${v}h`} />
                    <Tooltip
                      formatter={(value: number) => [`${value} שעות`, ""]}
                      labelFormatter={(label) => `יום ${label}`}
                      contentStyle={{ direction: "rtl" }}
                    />
                    <Bar dataKey="hours" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};

const Stat = ({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
}) => (
  <div className="rounded-lg border bg-muted/30 p-3">
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {icon}
      {label}
    </div>
    <div className="text-xl font-bold mt-1">{value}</div>
    {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
  </div>
);

export default WorkHoursCard;
