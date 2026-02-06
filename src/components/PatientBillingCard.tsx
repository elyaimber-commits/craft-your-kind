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
} from "lucide-react";

interface Patient {
  id: string;
  name: string;
  phone: string;
  session_price: number;
}

interface PatientBilling {
  patient: Patient;
  sessions: { date: string; summary: string; eventId?: string; calendarId?: string }[];
  total: number;
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
}

interface PatientBillingCardProps {
  billing: PatientBilling;
  payment?: Payment;
  currentMonth: string;
  isExpanded: boolean;
  onToggle: () => void;
  generateWhatsAppMessage: (billing: PatientBilling) => string;
}

const PatientBillingCard = ({
  billing,
  payment,
  currentMonth,
  isExpanded,
  onToggle,
  generateWhatsAppMessage,
}: PatientBillingCardProps) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [generatingReceipt, setGeneratingReceipt] = useState(false);

  const isPaid = payment?.paid || false;

  const markPaidMutation = useMutation({
    mutationFn: async () => {
      const markingAsPaid = !isPaid;
      
      if (payment) {
        const { error } = await supabase
          .from("payments")
          .update({
            paid: markingAsPaid,
            paid_at: markingAsPaid ? new Date().toISOString() : null,
            amount: billing.total,
            session_count: billing.sessions.length,
          })
          .eq("id", payment.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("payments").insert({
          therapist_id: user!.id,
          patient_id: billing.patient.id,
          month: currentMonth,
          amount: billing.total,
          session_count: billing.sessions.length,
          paid: true,
          paid_at: new Date().toISOString(),
        });
        if (error) throw error;
      }

      // If marking as paid, color events purple in Google Calendar
      if (markingAsPaid) {
        const eventIds = billing.sessions
          .filter(s => s.eventId && s.calendarId)
          .map(s => ({ eventId: s.eventId!, calendarId: s.calendarId! }));

        if (eventIds.length > 0) {
          try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
              await supabase.functions.invoke("google-calendar-update-colors", {
                headers: { Authorization: `Bearer ${session.access_token}` },
                body: { eventIds },
              });
            }
          } catch (colorError) {
            console.error("Failed to update calendar colors:", colorError);
            // Don't fail the whole operation if color update fails
          }
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      toast({
        title: !isPaid ? "סומן כשולם ✓ (והפגישות נצבעו בסגול)" : "סומן כלא שולם",
      });
    },
    onError: (error: any) => {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    },
  });

  const generateReceipt = () => {
    setGeneratingReceipt(true);
    try {
      const receiptContent = buildReceiptHTML(billing, currentMonth);
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

  return (
    <div
      className={`rounded-lg border bg-card ${
        isPaid ? "border-green-500/30 bg-green-50/30 dark:bg-green-950/10" : ""
      }`}
    >
      {/* Main row - always visible */}
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-lg">{billing.patient.name}</span>
            {isPaid && (
              <span className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-2 py-0.5 rounded-full">
                שולם ✓
              </span>
            )}
            <span className="text-sm text-muted-foreground">
              ({billing.sessions.length} פגישות)
            </span>
          </div>
          <span className="font-bold text-lg">₪{billing.total}</span>
        </div>

        {/* Action buttons - always visible */}
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
            variant={isPaid ? "outline" : "secondary"}
            onClick={() => markPaidMutation.mutate()}
            disabled={markPaidMutation.isPending}
          >
            {markPaidMutation.isPending ? (
              <Loader2 className="ml-1 h-4 w-4 animate-spin" />
            ) : (
              <Check className="ml-1 h-4 w-4" />
            )}
            {isPaid ? "בטל סימון תשלום" : "סמן כשולם"}
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

          {/* Expand/collapse for session details */}
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

      {/* Expandable session details */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-0 border-t">
          <div className="mt-3 space-y-1">
            {billing.sessions.map((session, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-sm py-1 px-2 rounded bg-accent/30 border-r-4 border-r-primary"
              >
                <span>{session.summary}</span>
                <span className="text-muted-foreground" dir="ltr">
                  {session.date}
                </span>
              </div>
            ))}
            <div className="flex justify-between pt-2 font-medium border-t mt-2">
              <span>
                {billing.sessions.length} × ₪{billing.patient.session_price}
              </span>
              <span>סה״כ: ₪{billing.total}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function buildReceiptHTML(billing: PatientBilling, month: string): string {
  const [year, mon] = month.split("-");
  const monthName = new Date(parseInt(year), parseInt(mon) - 1).toLocaleDateString("he-IL", {
    month: "long",
    year: "numeric",
  });
  const today = new Date().toLocaleDateString("he-IL");
  const receiptNum = `R-${Date.now().toString(36).toUpperCase()}`;

  const sessionsRows = billing.sessions
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
  <div class="total">סה״כ: ₪${billing.total}</div>
  <p style="margin-top:40px;font-size:12px;color:#999;text-align:center;">תודה רבה!</p>
</body></html>`;
}

export default PatientBillingCard;
