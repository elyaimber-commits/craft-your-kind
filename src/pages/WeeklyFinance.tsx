import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { getStoredVatRate } from "@/hooks/useAnalysisData";

const DAYS_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

function getWeekDates(weekOffset: number): Date[] {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sunday
  const sunday = new Date(today);
  sunday.setDate(today.getDate() - dayOfWeek + weekOffset * 7);
  sunday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
    return d;
  });
}

function formatDate(d: Date) {
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function toISODate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const normalizeName = (name: string): string =>
  name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()
    .replace(/[\u0591-\u05C7]/g, "").replace(/(.)\1+/g, "$1");

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  colorId?: string;
}

export default function WeeklyFinance() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [weekOffset, setWeekOffset] = useState(0);
  const vatRate = getStoredVatRate();
  const vatMultiplier = vatRate / 100;

  const weekDates = useMemo(() => getWeekDates(weekOffset), [weekOffset]);
  const weekStart = weekDates[0];
  const weekEnd = weekDates[6];

  // Determine which months this week spans
  const months = useMemo(() => {
    const monthSet = new Set<string>();
    weekDates.forEach((d) => {
      monthSet.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    });
    return Array.from(monthSet);
  }, [weekDates]);

  // Fetch calendar events for each month the week spans
  const { data: calendarEvents = [] } = useQuery({
    queryKey: ["weekly-calendar-events", ...months],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const allEvents: CalendarEvent[] = [];
      for (const month of months) {
        const res = await supabase.functions.invoke("google-calendar-billing", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          body: { month },
        });
        if (!res.error && res.data?.events) {
          allEvents.push(...res.data.events);
        }
      }
      return allEvents;
    },
    enabled: !!user,
  });

  // Fetch patients for matching
  const { data: patients = [] } = useQuery({
    queryKey: ["analysis-patients"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("patients")
        .select("id, name, session_price, commission_enabled, commission_type, commission_value");
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });

  // Fetch aliases
  const { data: aliases = [] } = useQuery({
    queryKey: ["event-aliases"],
    queryFn: async () => {
      const { data, error } = await supabase.from("event_aliases").select("*");
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });

  // Fetch session overrides
  const { data: sessionOverrides = [] } = useQuery({
    queryKey: ["session-overrides"],
    queryFn: async () => {
      const { data, error } = await supabase.from("session_overrides").select("*");
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });

  // Fetch expenses for this week
  const dateStrings = weekDates.map(toISODate);
  const { data: expenses = [] } = useQuery({
    queryKey: ["daily-expenses", dateStrings[0], dateStrings[6]],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_expenses")
        .select("*")
        .gte("date", dateStrings[0])
        .lte("date", dateStrings[6]);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });

  const aliasMap = useMemo(() => {
    const m = new Map<string, string>();
    aliases.forEach((a: any) => m.set(normalizeName(a.event_name), a.patient_id));
    return m;
  }, [aliases]);

  const overrideMap = useMemo(() => {
    const m = new Map<string, number>();
    sessionOverrides.forEach((o: any) => m.set(o.event_id, Number(o.custom_price)));
    return m;
  }, [sessionOverrides]);

  // Map events to days with prices
  const sessionsByDay = useMemo(() => {
    const now = new Date();
    const result: { price: number; summary: string }[][] = weekDates.map(() => []);

    for (const event of calendarEvents) {
      const eventDate = event.start.dateTime
        ? new Date(event.start.dateTime)
        : event.start.date
        ? new Date(event.start.date + "T00:00:00")
        : null;
      if (!eventDate || eventDate > now) continue;

      const dayIndex = weekDates.findIndex(
        (d) => d.getFullYear() === eventDate.getFullYear() && d.getMonth() === eventDate.getMonth() && d.getDate() === eventDate.getDate()
      );
      if (dayIndex === -1) continue;

      const normalizedEvent = normalizeName(event.summary || "");
      let matchedPatient: any = null;
      for (const p of patients) {
        if (normalizeName(p.name) === normalizedEvent) {
          matchedPatient = p;
          break;
        }
      }
      if (!matchedPatient) {
        const aliasPatientId = aliasMap.get(normalizedEvent);
        if (aliasPatientId) matchedPatient = patients.find((p: any) => p.id === aliasPatientId);
      }
      if (!matchedPatient) continue;

      const basePrice = overrideMap.has(event.id) ? overrideMap.get(event.id)! : matchedPatient.session_price;
      let commission = 0;
      if (matchedPatient.commission_enabled && matchedPatient.commission_value != null) {
        if (matchedPatient.commission_type === "percent") {
          commission = basePrice * (matchedPatient.commission_value / 100);
        } else {
          commission = matchedPatient.commission_value;
        }
      }
      const price = basePrice - commission;
      result[dayIndex].push({ price, summary: event.summary || "" });
    }
    return result;
  }, [calendarEvents, weekDates, patients, aliasMap, overrideMap]);

  // Daily totals
  const dailyTotals = useMemo(() => {
    return weekDates.map((d, i) => {
      const gross = sessionsByDay[i].reduce((s, sess) => s + sess.price, 0);
      const afterVat = gross - (gross * vatMultiplier / (1 + vatMultiplier));
      const dateStr = toISODate(d);
      const dayExpenses = [0, 1, 2, 3].map((slot) => {
        const exp = expenses.find((e: any) => e.date === dateStr && e.slot_index === slot);
        return { name: exp?.name || "", amount: exp?.amount || 0, id: exp?.id };
      });
      const totalExpenses = dayExpenses.reduce((s, e) => s + e.amount, 0);
      return { gross, afterVat, expenses: dayExpenses, totalExpenses, remaining: afterVat - totalExpenses };
    });
  }, [weekDates, sessionsByDay, expenses, vatMultiplier]);

  // Expense save mutation
  const saveExpenseMutation = useMutation({
    mutationFn: async ({ date, slotIndex, name, amount }: { date: string; slotIndex: number; name: string; amount: number }) => {
      if (!user) throw new Error("Not authenticated");
      if (amount === 0 && name === "") {
        // Delete if empty
        await supabase
          .from("daily_expenses")
          .delete()
          .eq("therapist_id", user.id)
          .eq("date", date)
          .eq("slot_index", slotIndex);
      } else {
        await supabase
          .from("daily_expenses")
          .upsert(
            { therapist_id: user.id, date, slot_index: slotIndex, name, amount },
            { onConflict: "therapist_id,date,slot_index" }
          );
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["daily-expenses"] });
    },
  });

  const maxSessions = Math.max(...sessionsByDay.map((s) => s.length), 1);

  const weekLabel = `${formatDate(weekStart)} - ${formatDate(weekEnd)}`;

  return (
    <div className="min-h-screen bg-background p-4 md:p-8" dir="rtl">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
            <ArrowRight className="h-5 w-5" />
          </Button>
          <h1 className="text-2xl sm:text-3xl font-bold">💰 כלכלה שבועית</h1>
        </div>

        {/* Week navigation */}
        <div className="mb-4 flex items-center gap-3">
          <Button variant="outline" size="icon" onClick={() => setWeekOffset((o) => o - 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="font-medium text-lg min-w-[140px] text-center" dir="ltr">{weekLabel}</span>
          <Button variant="outline" size="icon" onClick={() => setWeekOffset((o) => o + 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setWeekOffset(0)}>
            השבוע
          </Button>
        </div>

        {/* Weekly table */}
        <div className="rounded-lg border overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="p-2 text-right font-medium text-muted-foreground w-24"></th>
                {weekDates.map((d, i) => (
                  <th key={i} className="p-2 text-center font-medium min-w-[100px]">
                    <div>{DAYS_HE[i]}</div>
                    <div className="text-xs text-muted-foreground" dir="ltr">{formatDate(d)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Session rows - show prices */}
              {Array.from({ length: maxSessions }, (_, rowIdx) => (
                <tr key={`session-${rowIdx}`} className="border-b">
                  <td className="p-2 text-right text-muted-foreground text-xs">פגישה {rowIdx + 1}</td>
                  {weekDates.map((_, dayIdx) => {
                    const session = sessionsByDay[dayIdx][rowIdx];
                    return (
                      <td key={dayIdx} className="p-2 text-center">
                        {session ? `₪${session.price}` : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}

              {/* Totals row */}
              <tr className="border-b bg-muted/30 font-semibold">
                <td className="p-2 text-right">סה״כ</td>
                {dailyTotals.map((dt, i) => (
                  <td key={i} className="p-2 text-center">
                    {dt.gross > 0 ? `₪${dt.gross.toLocaleString("he-IL")}` : "—"}
                  </td>
                ))}
              </tr>

              {/* After VAT row */}
              <tr className="border-b bg-muted/30">
                <td className="p-2 text-right font-medium">אחרי מע״מ</td>
                {dailyTotals.map((dt, i) => (
                  <td key={i} className="p-2 text-center font-medium">
                    {dt.afterVat > 0 ? `₪${Math.round(dt.afterVat).toLocaleString("he-IL")}` : "—"}
                  </td>
                ))}
              </tr>

              {/* Separator */}
              <tr className="border-b-2 border-border">
                <td colSpan={8} className="p-1 bg-muted/20 text-xs text-center text-muted-foreground">הוצאות</td>
              </tr>

              {/* 4 Expense rows */}
              {[0, 1, 2, 3].map((slotIdx) => (
                <tr key={`expense-${slotIdx}`} className="border-b">
                  <td className="p-2 text-right text-muted-foreground text-xs">הוצאה {slotIdx + 1}</td>
                  {weekDates.map((d, dayIdx) => {
                    const exp = dailyTotals[dayIdx].expenses[slotIdx];
                    return (
                      <td key={dayIdx} className="p-1">
                        <ExpenseCell
                          name={exp.name}
                          amount={exp.amount}
                          onSave={(name, amount) =>
                            saveExpenseMutation.mutate({
                              date: toISODate(d),
                              slotIndex: slotIdx,
                              name,
                              amount,
                            })
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}

              {/* Remaining row */}
              <tr className="bg-muted/50 font-bold">
                <td className="p-2 text-right">נשאר</td>
                {dailyTotals.map((dt, i) => (
                  <td key={i} className={`p-2 text-center ${dt.remaining < 0 ? "text-destructive" : ""}`}>
                    {dt.afterVat > 0 || dt.totalExpenses > 0
                      ? `₪${Math.round(dt.remaining).toLocaleString("he-IL")}`
                      : "—"}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Inline editable expense cell
function ExpenseCell({
  name,
  amount,
  onSave,
}: {
  name: string;
  amount: number;
  onSave: (name: string, amount: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [localName, setLocalName] = useState(name);
  const [localAmount, setLocalAmount] = useState(amount ? String(amount) : "");

  const handleSave = () => {
    const parsedAmount = parseFloat(localAmount) || 0;
    if (parsedAmount !== amount || localName !== name) {
      onSave(localName, parsedAmount);
    }
    setEditing(false);
  };

  if (!editing) {
    return (
      <div
        className="cursor-pointer text-center text-xs min-h-[28px] flex items-center justify-center rounded hover:bg-accent/50 transition-colors"
        onClick={() => {
          setLocalName(name);
          setLocalAmount(amount ? String(amount) : "");
          setEditing(true);
        }}
      >
        {amount > 0 ? (
          <span>
            <span className="text-muted-foreground">{name} </span>
            <span className="font-medium">₪{amount}</span>
          </span>
        ) : (
          <span className="text-muted-foreground/40">+</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Input
        value={localName}
        onChange={(e) => setLocalName(e.target.value)}
        placeholder="שם"
        className="h-6 text-xs px-1"
        autoFocus
      />
      <Input
        type="number"
        value={localAmount}
        onChange={(e) => setLocalAmount(e.target.value)}
        placeholder="סכום"
        className="h-6 text-xs px-1"
        dir="ltr"
        onBlur={handleSave}
        onKeyDown={(e) => e.key === "Enter" && handleSave()}
      />
    </div>
  );
}
