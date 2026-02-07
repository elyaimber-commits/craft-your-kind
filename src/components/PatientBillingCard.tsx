import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  MessageCircle,
  ChevronDown,
  ChevronUp,
  Check,
  FileText,
  Loader2,
  RefreshCw,
} from "lucide-react";

interface Patient {
  id: string;
  name: string;
  phone: string;
  session_price: number;
}

interface Session {
  date: string;
  summary: string;
  eventId?: string;
  calendarId?: string;
  childPatientName?: string;
}

interface PatientBilling {
  patient: Patient;
  sessions: Session[];
  total: number;
  childPatients?: Patient[];
}

interface Payment {
  id: string;
  patient_id: string;
  month: string;
  amount: number;
  session_count: number;
  paid: boolean;
  paid_at: string | null;
  receipt_number: string | null;
  paid_event_ids?: string[];
}

interface PatientBillingCardProps {
  billing: PatientBilling;
  payment?: Payment;
  currentMonth: string;
  isExpanded: boolean;
  onToggle: () => void;
  generateWhatsAppMessage: (billing: PatientBilling) => string;
  calendarEventName?: string;
}

const PatientBillingCard = ({
  billing,
  payment,
  currentMonth,
  isExpanded,
  onToggle,
  generateWhatsAppMessage,
  calendarEventName,
}: PatientBillingCardProps) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [generatingReceipt, setGeneratingReceipt] = useState(false);
  const [renamingInCalendar, setRenamingInCalendar] = useState(false);
  const [togglingSession, setTogglingSession] = useState<string | null>(null);

  const paidEventIds = new Set(payment?.paid_event_ids || []);
  const paidCount = billing.sessions.filter(s => s.eventId && paidEventIds.has(s.eventId)).length;
  const allPaid = paidCount === billing.sessions.length && billing.sessions.length > 0;
  const somePaid = paidCount > 0;
  const paidAmount = paidCount * billing.patient.session_price;

  // Toggle a single session's paid status
  const toggleSessionPaid = async (session: Session) => {
    if (!session.eventId || !user) return;
    setTogglingSession(session.eventId);
    try {
      const currentPaidIds = payment?.paid_event_ids || [];
      const isPaidNow = currentPaidIds.includes(session.eventId);
      const newPaidIds = isPaidNow
        ? currentPaidIds.filter(id => id !== session.eventId)
        : [...currentPaidIds, session.eventId];

      const newPaidCount = newPaidIds.length;
      const newAmount = newPaidCount * billing.patient.session_price;
      const newAllPaid = newPaidCount === billing.sessions.length;

      if (payment) {
        await supabase
          .from("payments")
          .update({
            paid: newAllPaid,
            paid_at: newPaidCount > 0 ? new Date().toISOString() : null,
            amount: newAmount,
            session_count: newPaidCount,
            paid_event_ids: newPaidIds,
          })
          .eq("id", payment.id);
      } else {
        await supabase.from("payments").insert({
          therapist_id: user.id,
          patient_id: billing.patient.id,
          month: currentMonth,
          amount: newAmount,
          session_count: newPaidCount,
          paid: newAllPaid,
          paid_at: new Date().toISOString(),
          paid_event_ids: newPaidIds,
        });
      }

      // Update single calendar event color
      if (session.eventId && session.calendarId) {
        try {
          const { data: { session: authSession } } = await supabase.auth.getSession();
          if (authSession) {
            await supabase.functions.invoke("google-calendar-update-colors", {
              headers: { Authorization: `Bearer ${authSession.access_token}` },
              body: {
                eventIds: [{ eventId: session.eventId, calendarId: session.calendarId }],
                colorId: isPaidNow ? "5" : "3", // toggle: paid→yellow, unpaid→purple
              },
            });
          }
        } catch (e) {
          console.error("Failed to update calendar color:", e);
        }
      }

      queryClient.invalidateQueries({ queryKey: ["payments"] });
    } catch (error: any) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    } finally {
      setTogglingSession(null);
    }
  };

  // Mark all sessions paid/unpaid
  const markAllMutation = useMutation({
    mutationFn: async () => {
      const markingAsPaid = !allPaid;
      const newPaidIds = markingAsPaid
        ? billing.sessions.filter(s => s.eventId).map(s => s.eventId!)
        : [];
      const newAmount = markingAsPaid ? billing.total : 0;
      const newCount = markingAsPaid ? billing.sessions.length : 0;

      if (payment) {
        await supabase
          .from("payments")
          .update({
            paid: markingAsPaid,
            paid_at: markingAsPaid ? new Date().toISOString() : null,
            amount: newAmount,
            session_count: newCount,
            paid_event_ids: newPaidIds,
          })
          .eq("id", payment.id);
      } else {
        await supabase.from("payments").insert({
          therapist_id: user!.id,
          patient_id: billing.patient.id,
          month: currentMonth,
          amount: newAmount,
          session_count: newCount,
          paid: true,
          paid_at: new Date().toISOString(),
          paid_event_ids: newPaidIds,
        });
      }

      // Update all calendar event colors
      const eventIds = billing.sessions
        .filter(s => s.eventId && s.calendarId)
        .map(s => ({ eventId: s.eventId!, calendarId: s.calendarId! }));

      if (eventIds.length > 0) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            await supabase.functions.invoke("google-calendar-update-colors", {
              headers: { Authorization: `Bearer ${session.access_token}` },
              body: { eventIds, colorId: markingAsPaid ? "3" : "5" },
            });
          }
        } catch (e) {
          console.error("Failed to update calendar colors:", e);
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      toast({
        title: !allPaid ? "כל הפגישות סומנו כשולמו ✓" : "בוטל סימון תשלום",
      });
    },
    onError: (error: any) => {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    },
  });

  const generateReceipt = () => {
    setGeneratingReceipt(true);
    try {
      const receiptContent = buildReceiptHTML(billing, currentMonth, paidEventIds);
      const printWindow = window.open("", "_blank");
      if (printWindow) {
        printWindow.document.write(receiptContent);
        printWindow.document.close();
        printWindow.focus();
        setTimeout(() => printWindow.print(), 500);
      }
    } finally {
      setGeneratingReceipt(false);
    }
  };

  const renameInCalendar = async () => {
    if (!calendarEventName) return;
    setRenamingInCalendar(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const res = await supabase.functions.invoke("google-calendar-rename-events", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { oldName: calendarEventName, newName: billing.patient.name },
      });
      if (res.error) throw res.error;
      const result = res.data;
      toast({
        title: `עודכנו ${result.updated} אירועים ביומן`,
        description: `"${calendarEventName}" → "${billing.patient.name}"`,
      });
      queryClient.invalidateQueries({ queryKey: ["google-calendar-events-billing"] });
    } catch (error: any) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    } finally {
      setRenamingInCalendar(false);
    }
  };

  return (
    <div
      className={`rounded-lg border bg-card ${
        allPaid
          ? "border-green-500/30 bg-green-50/30 dark:bg-green-950/10"
          : somePaid
          ? "border-yellow-500/30 bg-yellow-50/20 dark:bg-yellow-950/10"
          : ""
      }`}
    >
      {/* Main row */}
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-lg">{billing.patient.name}</span>
            {(billing.patient as any).billing_type === "institution" && (
              <span className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 px-2 py-0.5 rounded-full">
                מוסד
              </span>
            )}
            {allPaid && (
              <span className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-2 py-0.5 rounded-full">
                שולם ✓
              </span>
            )}
            {somePaid && !allPaid && (
              <span className="text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 px-2 py-0.5 rounded-full">
                שולם חלקית ({paidCount}/{billing.sessions.length})
              </span>
            )}
            <span className="text-sm text-muted-foreground">
              ({billing.sessions.length} פגישות{billing.childPatients && billing.childPatients.length > 0 ? ` · ${billing.childPatients.length} מטופלים` : ""})
            </span>
          </div>
          <div className="text-left">
            <span className="font-bold text-lg">₪{billing.total}</span>
            {somePaid && !allPaid && (
              <div className="text-xs text-muted-foreground">
                שולם: ₪{paidAmount} · נותר: ₪{billing.total - paidAmount}
              </div>
            )}
          </div>
        </div>

        {/* Calendar name mismatch notice */}
        {calendarEventName && calendarEventName !== billing.patient.name && (
          <div className="flex items-center gap-2 text-sm bg-accent/50 rounded px-3 py-1.5">
            <span className="text-muted-foreground">
              ביומן: &quot;{calendarEventName}&quot; → באפליקציה: &quot;{billing.patient.name}&quot;
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={renameInCalendar}
              disabled={renamingInCalendar}
              className="h-7 text-xs mr-auto"
            >
              {renamingInCalendar ? (
                <Loader2 className="ml-1 h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="ml-1 h-3 w-3" />
              )}
              עדכן ביומן
            </Button>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => window.open(generateWhatsAppMessage(billing), "_blank")}
          >
            <MessageCircle className="ml-1 h-4 w-4" />
            שלח בקשת תשלום
          </Button>

          <Button
            size="sm"
            variant={allPaid ? "outline" : "secondary"}
            onClick={() => markAllMutation.mutate()}
            disabled={markAllMutation.isPending}
          >
            {markAllMutation.isPending ? (
              <Loader2 className="ml-1 h-4 w-4 animate-spin" />
            ) : (
              <Check className="ml-1 h-4 w-4" />
            )}
            {allPaid ? "בטל הכל" : "סמן הכל כשולם"}
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => generateReceipt()}
            disabled={generatingReceipt}
          >
            <FileText className="ml-1 h-4 w-4" />
            הנפק קבלה
          </Button>

          <button
            onClick={onToggle}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mr-auto"
          >
            {isExpanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
            פירוט
          </button>
        </div>
      </div>

      {/* Expandable session details with per-session toggle */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-0 border-t">
          <div className="mt-3 space-y-1">
            {billing.sessions.map((session, i) => {
              const isSessionPaid = session.eventId ? paidEventIds.has(session.eventId) : false;
              const isToggling = togglingSession === session.eventId;
              return (
                <div
                  key={i}
                  className={`flex items-center justify-between text-sm py-1.5 px-2 rounded border-r-4 cursor-pointer transition-colors ${
                    isSessionPaid
                      ? "bg-green-50/50 dark:bg-green-950/20 border-r-green-500"
                      : "bg-accent/30 border-r-primary"
                  }`}
                  onClick={() => toggleSessionPaid(session)}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
                      isSessionPaid
                        ? "bg-green-500 border-green-500 text-white"
                        : "border-muted-foreground/40"
                    }`}>
                      {isToggling ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : isSessionPaid ? (
                        <Check className="h-3 w-3" />
                      ) : null}
                    </div>
                    <span className={isSessionPaid ? "line-through text-muted-foreground" : ""}>
                      {session.summary}
                    </span>
                    {session.childPatientName && (
                      <span className="text-xs text-muted-foreground">({session.childPatientName})</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground">₪{billing.patient.session_price}</span>
                    <span className="text-muted-foreground" dir="ltr">
                      {session.date}
                    </span>
                  </div>
                </div>
              );
            })}
            <div className="flex justify-between pt-2 font-medium border-t mt-2">
              <span>
                {billing.sessions.length} × ₪{billing.patient.session_price}
              </span>
              <div className="flex gap-3">
                {somePaid && !allPaid && (
                  <span className="text-green-600 dark:text-green-400">שולם: ₪{paidAmount}</span>
                )}
                <span>סה״כ: ₪{billing.total}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function buildReceiptHTML(billing: PatientBilling, month: string, paidEventIds: Set<string>): string {
  const [year, mon] = month.split("-");
  const monthName = new Date(parseInt(year), parseInt(mon) - 1).toLocaleDateString("he-IL", {
    month: "long",
    year: "numeric",
  });
  const today = new Date().toLocaleDateString("he-IL");
  const receiptNum = `R-${Date.now().toString(36).toUpperCase()}`;

  // Only include paid sessions in receipt
  const paidSessions = paidEventIds.size > 0
    ? billing.sessions.filter(s => s.eventId && paidEventIds.has(s.eventId))
    : billing.sessions;

  const paidTotal = paidSessions.length * billing.patient.session_price;

  const sessionsRows = paidSessions
    .map(
      (s, i) =>
        `<tr><td style="padding:6px;border-bottom:1px solid #eee;">${i + 1}</td><td style="padding:6px;border-bottom:1px solid #eee;">${s.summary}</td><td style="padding:6px;border-bottom:1px solid #eee;" dir="ltr">${s.date}</td><td style="padding:6px;border-bottom:1px solid #eee;">₪${billing.patient.session_price}</td></tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"><title>קבלה - ${billing.patient.name}</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; color: #333; }
  h1 { text-align: center; font-size: 24px; margin-bottom: 4px; }
  .subtitle { text-align: center; color: #666; margin-bottom: 30px; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 14px; color: #666; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { background: #f5f5f5; padding: 8px; text-align: right; border-bottom: 2px solid #ddd; }
  .total { text-align: left; font-size: 20px; font-weight: bold; padding: 10px 0; border-top: 2px solid #333; }
  @media print { body { margin: 0; } }
</style></head>
<body>
  <h1>קבלה</h1>
  <p class="subtitle">${monthName}</p>
  <div class="meta">
    <span>לכבוד: <strong>${billing.patient.name}</strong></span>
    <span>תאריך: ${today}</span>
  </div>
  <div class="meta">
    <span>מספר קבלה: ${receiptNum}</span>
  </div>
  <table>
    <thead><tr><th>#</th><th>תיאור</th><th>תאריך</th><th>סכום</th></tr></thead>
    <tbody>${sessionsRows}</tbody>
  </table>
  <div class="total">סה״כ: ₪${paidTotal}</div>
  <p style="margin-top:40px;font-size:12px;color:#999;text-align:center;">תודה רבה!</p>
</body></html>`;
}

export default PatientBillingCard;
