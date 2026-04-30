import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Patient {
  id: string;
  name: string;
  session_price: number;
}

interface SessionLite {
  date: string;          // formatted "D/M/YY"
  summary: string;
  eventId?: string;
  calendarId?: string;
  sessionPrice?: number;
  startISO?: string;     // for chronological sort across months
}

interface PriorDebtDetail {
  month: string;         // "YYYY-MM"
  debt: number;
  paymentId?: string;
}

interface ExistingPayment {
  id: string;
  amount: number;
  paid_event_ids?: string[];
  total_billed?: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  amount: number;
  patient: Patient;
  currentMonth: string;                       // "YYYY-MM"
  currentMonthSessions: SessionLite[];        // already loaded for current month
  currentMonthBillingTotal: number;
  currentMonthPayment?: ExistingPayment;
  priorDebtDetails: PriorDebtDetail[];
  aliasNames: string[];                       // names that map to this patient (for matching)
}

interface AssignedSession {
  monthKey: string;       // "YYYY-MM"
  monthLabel: string;
  date: string;
  summary: string;
  eventId: string;
  calendarId: string;
  price: number;
  alreadyPaid: number;    // amount that was already paid before this run (for partial overflow)
  paidNow: number;        // how much of this payment goes to this session
  fullyCovered: boolean;  // becomes fully paid after this allocation
  paymentId?: string;     // payment row id for that month
}

const PURPLE = "3";
const LAVENDER = "1";

function monthKeyFromISO(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(monthKey: string) {
  const [y, m] = monthKey.split("-");
  const d = new Date(parseInt(y), parseInt(m) - 1);
  return d.toLocaleDateString("he-IL", { month: "long", year: "numeric" });
}

function formatDate(iso: string) {
  const d = new Date(iso);
  const day = d.getDate();
  const mo = d.getMonth() + 1;
  const yr = String(d.getFullYear()).slice(-2);
  return `${day}/${mo}/${yr}`;
}

function normalize(s: string) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

const PartialPaymentDialog = ({
  open,
  onOpenChange,
  amount,
  patient,
  currentMonth,
  currentMonthSessions,
  currentMonthBillingTotal,
  currentMonthPayment,
  priorDebtDetails,
  aliasNames,
}: Props) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [priorMonthSessions, setPriorMonthSessions] = useState<
    Record<string, SessionLite[]>
  >({});
  const [priorMonthPayments, setPriorMonthPayments] = useState<
    Record<string, ExistingPayment>
  >({});
  const [error, setError] = useState<string | null>(null);

  // Fetch prior-month sessions when dialog opens (only if there's prior debt)
  useEffect(() => {
    if (!open) return;
    setError(null);
    const monthsToLoad = priorDebtDetails.map((d) => d.month);
    if (monthsToLoad.length === 0) {
      setPriorMonthSessions({});
      setPriorMonthPayments({});
      return;
    }

    const load = async () => {
      setLoading(true);
      try {
        const { data: { session: authSession } } = await supabase.auth.getSession();
        if (!authSession) throw new Error("Not authenticated");

        // Pull payments for those months to know paid_event_ids
        const { data: payRows } = await supabase
          .from("payments")
          .select("id, amount, paid_event_ids, total_billed, month")
          .eq("patient_id", patient.id)
          .in("month", monthsToLoad);

        const payMap: Record<string, ExistingPayment> = {};
        (payRows || []).forEach((p: any) => {
          payMap[p.month] = {
            id: p.id,
            amount: Number(p.amount || 0),
            paid_event_ids: p.paid_event_ids || [],
            total_billed: p.total_billed != null ? Number(p.total_billed) : undefined,
          };
        });
        setPriorMonthPayments(payMap);

        // Fetch session_overrides once
        const { data: overrides } = await supabase
          .from("session_overrides")
          .select("event_id, custom_price")
          .eq("patient_id", patient.id);
        const overrideMap = new Map<string, number>();
        (overrides || []).forEach((o: any) => overrideMap.set(o.event_id, Number(o.custom_price)));

        // Fetch ignored events
        const { data: ignored } = await supabase
          .from("ignored_calendar_events")
          .select("event_name");
        const ignoredSet = new Set((ignored || []).map((i: any) => normalize(i.event_name)));

        // Build name set for matching this patient
        const nameSet = new Set<string>([normalize(patient.name), ...aliasNames.map(normalize)]);

        const result: Record<string, SessionLite[]> = {};
        for (const m of monthsToLoad) {
          const res = await supabase.functions.invoke("google-calendar-billing", {
            headers: { Authorization: `Bearer ${authSession.access_token}` },
            body: { month: m },
          });
          if (res.error) throw res.error;
          const events = (res.data?.events || []) as any[];
          const matched: SessionLite[] = events
            .filter((ev) => {
              const title = normalize(ev.summary || "");
              if (!title) return false;
              if (ignoredSet.has(title)) return false;
              return nameSet.has(title);
            })
            .filter((ev) => ev.start?.dateTime) // skip all-day
            .map((ev) => {
              const startISO = ev.start.dateTime as string;
              const eventId = ev.id as string;
              const calendarId = ev.organizer?.email || ev.calendarId || "primary";
              const price =
                overrideMap.get(eventId) ?? Number(patient.session_price);
              return {
                date: formatDate(startISO),
                summary: ev.summary,
                eventId,
                calendarId,
                sessionPrice: price,
                startISO,
              };
            })
            .sort((a, b) => (a.startISO! < b.startISO! ? -1 : 1));
          result[m] = matched;
        }
        setPriorMonthSessions(result);
      } catch (e: any) {
        console.error(e);
        setError(e.message || "שגיאה בטעינת פגישות מחודשים קודמים");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [open, patient.id, priorDebtDetails.map((d) => d.month).join(",")]);

  // Build ordered list of all candidate sessions across months (FIFO):
  // older months first, then current month; within month, chronological.
  const plan = useMemo(() => {
    if (loading) return null;
    const orderedMonths = [
      ...priorDebtDetails.map((d) => d.month).sort(),
      currentMonth,
    ];

    const allCandidates: {
      monthKey: string;
      session: SessionLite;
      alreadyPaidEventIds: Set<string>;
      paymentId?: string;
    }[] = [];

    for (const m of orderedMonths) {
      const isCurrent = m === currentMonth;
      const sessions = isCurrent ? currentMonthSessions : (priorMonthSessions[m] || []);
      const payment = isCurrent ? currentMonthPayment : priorMonthPayments[m];
      const paidIds = new Set(payment?.paid_event_ids || []);

      // Only include past sessions (already happened)
      const now = new Date();
      const past = sessions.filter((s) => {
        if (!s.eventId) return false;
        if (s.startISO) return new Date(s.startISO) <= now;
        return true; // current month sessions without startISO are assumed already filtered upstream
      });

      for (const s of past) {
        allCandidates.push({
          monthKey: m,
          session: s,
          alreadyPaidEventIds: paidIds,
          paymentId: payment?.id,
        });
      }
    }

    // Allocate the new payment amount across UNPAID sessions, FIFO.
    let remaining = amount;
    const assigned: AssignedSession[] = [];
    for (const c of allCandidates) {
      if (remaining <= 0) break;
      if (c.alreadyPaidEventIds.has(c.session.eventId!)) continue; // skip already paid
      const price = c.session.sessionPrice ?? patient.session_price;
      const pay = Math.min(remaining, price);
      assigned.push({
        monthKey: c.monthKey,
        monthLabel: monthLabel(c.monthKey),
        date: c.session.date,
        summary: c.session.summary,
        eventId: c.session.eventId!,
        calendarId: c.session.calendarId || "primary",
        price,
        alreadyPaid: 0,
        paidNow: pay,
        fullyCovered: pay >= price,
        paymentId: c.paymentId,
      });
      remaining -= pay;
    }

    return { assigned, leftover: remaining };
  }, [
    loading,
    amount,
    currentMonth,
    currentMonthSessions,
    currentMonthPayment,
    priorMonthSessions,
    priorMonthPayments,
    priorDebtDetails,
    patient.session_price,
  ]);

  // Group plan by month for display
  const grouped = useMemo(() => {
    if (!plan) return [];
    const map = new Map<string, AssignedSession[]>();
    for (const a of plan.assigned) {
      if (!map.has(a.monthKey)) map.set(a.monthKey, []);
      map.get(a.monthKey)!.push(a);
    }
    return Array.from(map.entries()).map(([monthKey, items]) => ({
      monthKey,
      monthLabel: monthLabel(monthKey),
      items,
    }));
  }, [plan]);

  const handleConfirm = async () => {
    if (!plan || !user) return;
    setConfirming(true);
    try {
      const { data: { session: authSession } } = await supabase.auth.getSession();
      if (!authSession) throw new Error("Not authenticated");

      // Group by month for DB updates
      const byMonth = new Map<string, AssignedSession[]>();
      for (const a of plan.assigned) {
        if (!byMonth.has(a.monthKey)) byMonth.set(a.monthKey, []);
        byMonth.get(a.monthKey)!.push(a);
      }

      // Update payments per month
      for (const [monthKey, items] of byMonth.entries()) {
        const isCurrent = monthKey === currentMonth;
        const existingPayment = isCurrent ? currentMonthPayment : priorMonthPayments[monthKey];
        const totalAddedToThisMonth = items.reduce((s, i) => s + i.paidNow, 0);
        const newlyFullyPaidEventIds = items
          .filter((i) => i.fullyCovered)
          .map((i) => i.eventId);

        if (existingPayment) {
          const newPaidIds = Array.from(new Set([
            ...(existingPayment.paid_event_ids || []),
            ...newlyFullyPaidEventIds,
          ]));
          const newAmount = Number(existingPayment.amount || 0) + totalAddedToThisMonth;
          const totalBilled = existingPayment.total_billed;
          const newPaid = totalBilled != null ? newAmount >= totalBilled : false;
          await supabase
            .from("payments")
            .update({
              amount: newAmount,
              paid_event_ids: newPaidIds,
              session_count: newPaidIds.length,
              paid: newPaid,
              paid_at: new Date().toISOString(),
            })
            .eq("id", existingPayment.id);
        } else {
          // Only happens for current month if no payment row exists yet
          await supabase.from("payments").insert({
            therapist_id: user.id,
            patient_id: patient.id,
            month: monthKey,
            amount: totalAddedToThisMonth,
            total_billed: isCurrent ? currentMonthBillingTotal : undefined,
            session_count: newlyFullyPaidEventIds.length,
            paid:
              isCurrent && totalAddedToThisMonth >= currentMonthBillingTotal,
            paid_at: new Date().toISOString(),
            paid_event_ids: newlyFullyPaidEventIds,
          });
        }
      }

      // Apply colors in calendar
      const fullyPaidByCalendar = plan.assigned
        .filter((a) => a.fullyCovered)
        .map((a) => ({ eventId: a.eventId, calendarId: a.calendarId }));
      const partialByCalendar = plan.assigned
        .filter((a) => !a.fullyCovered && a.paidNow > 0)
        .map((a) => ({ eventId: a.eventId, calendarId: a.calendarId }));

      if (fullyPaidByCalendar.length > 0) {
        await supabase.functions.invoke("google-calendar-update-colors", {
          headers: { Authorization: `Bearer ${authSession.access_token}` },
          body: { eventIds: fullyPaidByCalendar, colorId: PURPLE },
        });
      }
      if (partialByCalendar.length > 0) {
        await supabase.functions.invoke("google-calendar-update-colors", {
          headers: { Authorization: `Bearer ${authSession.access_token}` },
          body: { eventIds: partialByCalendar, colorId: LAVENDER },
        });
      }

      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["payments-prior-debts"] });
      queryClient.invalidateQueries({ queryKey: ["google-calendar-events-billing"] });

      const summaryParts = [
        fullyPaidByCalendar.length > 0
          ? `${fullyPaidByCalendar.length} פגישות סומנו כשולמו`
          : "",
        partialByCalendar.length > 0 ? `1 פגישה סומנה חלקית` : "",
      ].filter(Boolean);
      toast({ title: `נוסף תשלום של ₪${amount}`, description: summaryParts.join(" · ") });
      onOpenChange(false);
    } catch (e: any) {
      console.error(e);
      toast({ title: "שגיאה", description: e.message, variant: "destructive" });
    } finally {
      setConfirming(false);
    }
  };

  const totalAllocated = plan ? plan.assigned.reduce((s, a) => s + a.paidNow, 0) : 0;
  const leftover = plan ? plan.leftover : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>אישור חלוקת תשלום של ₪{amount}</DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>טוען פגישות מחודשים קודמים...</span>
          </div>
        )}

        {error && (
          <div className="bg-destructive/10 text-destructive text-sm p-3 rounded">
            {error}
          </div>
        )}

        {!loading && !error && plan && (
          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            <p className="text-sm text-muted-foreground">
              התשלום יחולק לפי הסדר הכרונולוגי (FIFO) — קודם החובות הישנים, ואז החודש הנוכחי.
            </p>

            {grouped.length === 0 && (
              <div className="text-sm text-muted-foreground py-4 text-center">
                אין פגישות לא משולמות לחלוקה. כל הסכום יישמר כעודף.
              </div>
            )}

            {grouped.map((g) => (
              <div key={g.monthKey} className="border rounded-lg p-3 space-y-2">
                <div className="font-medium text-sm">{g.monthLabel}</div>
                {g.items.map((item) => (
                  <div
                    key={item.eventId}
                    className={`flex items-center justify-between text-sm py-1.5 px-2 rounded border-r-4 ${
                      item.fullyCovered
                        ? "bg-purple-50 dark:bg-purple-950/20 border-r-purple-500"
                        : "bg-violet-50 dark:bg-violet-950/20 border-r-violet-300"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block w-3 h-3 rounded ${
                          item.fullyCovered ? "bg-purple-500" : "bg-violet-300"
                        }`}
                        title={item.fullyCovered ? "סגול - שולם במלואו" : "לבנדר - שולם חלקית"}
                      />
                      <span>{item.summary}</span>
                      <span className="text-muted-foreground text-xs" dir="ltr">
                        {item.date}
                      </span>
                    </div>
                    <div className="text-xs">
                      {item.fullyCovered ? (
                        <span className="text-purple-700 dark:text-purple-400 font-medium">
                          ₪{item.paidNow}
                        </span>
                      ) : (
                        <span className="text-violet-700 dark:text-violet-400">
                          ₪{item.paidNow} מתוך ₪{item.price} (חוב נותר ₪{item.price - item.paidNow})
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}

            <div className="text-xs text-muted-foreground pt-2 border-t space-y-1">
              <div>סה״כ הוקצה לפגישות: ₪{totalAllocated}</div>
              {leftover > 0 && (
                <div className="text-amber-600 dark:text-amber-400">
                  עודף שיישמר כתשלום נוסף בחודש הנוכחי: ₪{leftover}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="flex-row gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={confirming}
          >
            ביטול
          </Button>
          <Button onClick={handleConfirm} disabled={loading || confirming || !plan}>
            {confirming ? (
              <>
                <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                מעדכן...
              </>
            ) : (
              "אישור וצביעה ביומן"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PartialPaymentDialog;
