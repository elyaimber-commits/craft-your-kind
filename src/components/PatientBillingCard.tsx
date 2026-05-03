import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import PartialPaymentDialog from "./PartialPaymentDialog";
import GreenInvoiceCreateDialog from "./GreenInvoiceCreateDialog";
import SessionNoteRecorderDialog from "./SessionNoteRecorderDialog";
import DriveFolderPickerDialog from "./DriveFolderPickerDialog";
import {
  MessageCircle,
  ChevronDown,
  ChevronUp,
  Check,
  Loader2,
  RefreshCw,
  Pencil,
  Trash2,
  Plus,
  FileText,
  Mic,
  FolderCog,
  Folder,
} from "lucide-react";

interface Patient {
  id: string;
  name: string;
  phone: string;
  session_price: number;
}

interface ManualDebt {
  id: string;
  amount: number;
  note: string | null;
}

interface Session {
  date: string;
  summary: string;
  eventId?: string;
  calendarId?: string;
  childPatientName?: string;
  sessionPrice?: number;
  startISO?: string;
  isPaidPending?: boolean;
}

interface PatientBilling {
  patient: Patient;
  sessions: Session[];
  total: number;
  childPatients?: Patient[];
}

interface PriorDebtDetail {
  month: string;
  debt: number;
  paymentId?: string;
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
  total_billed?: number;
}

interface PatientBillingCardProps {
  billing: PatientBilling;
  payment?: Payment;
  currentMonth: string;
  isExpanded: boolean;
  onToggle: () => void;
  generateWhatsAppMessage: (billing: PatientBilling) => string;
  calendarEventName?: string;
  priorDebtDetails?: PriorDebtDetail[];
  manualDebts?: ManualDebt[];
  paymentRequestSentAt?: string | null;
  onPaymentRequestSent?: () => void;
}

const PatientBillingCard = ({
  billing,
  payment,
  currentMonth,
  isExpanded,
  onToggle,
  generateWhatsAppMessage,
  calendarEventName,
  priorDebtDetails = [],
  manualDebts = [],
  paymentRequestSentAt = null,
  onPaymentRequestSent,
}: PatientBillingCardProps) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [renamingInCalendar, setRenamingInCalendar] = useState(false);
  const [togglingSession, setTogglingSession] = useState<string | null>(null);
  const [editingPriceEventId, setEditingPriceEventId] = useState<string | null>(null);
  const [editPriceValue, setEditPriceValue] = useState("");
  const [togglingPriorMonth, setTogglingPriorMonth] = useState<string | null>(null);

  const paidEventIds = new Set(payment?.paid_event_ids || []);
  const paidCount = billing.sessions.filter(s => s.eventId && paidEventIds.has(s.eventId)).length;
  const sessionsPaidAmount = billing.sessions
    .filter(s => s.eventId && paidEventIds.has(s.eventId))
    .reduce((sum, s) => sum + (s.sessionPrice ?? billing.patient.session_price), 0);
  // Extra partial payment = amount stored beyond what sessions cover
  const extraPaid = Math.max(0, (payment?.amount ?? 0) - sessionsPaidAmount);
  const paidAmount = sessionsPaidAmount + extraPaid;
  const allPaid = paidAmount >= billing.total && billing.sessions.length > 0;
  const somePaid = paidAmount > 0;
  const [extraInput, setExtraInput] = useState("");
  const [savingExtra, setSavingExtra] = useState(false);
  const [partialDialogOpen, setPartialDialogOpen] = useState(false);
  const [pendingAmount, setPendingAmount] = useState(0);
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [recorderSession, setRecorderSession] = useState<Session | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  const driveFolderId = (billing.patient as any).drive_folder_id || null;
  const driveFolderName = (billing.patient as any).drive_folder_name || null;

  const openWhatsAppRequest = () => {
    const url = generateWhatsAppMessage(billing);
    const a = document.createElement("a");
    a.href = `/whatsapp-redirect.html?to=${encodeURIComponent(url)}&delay=75`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    onPaymentRequestSent?.();
  };

  // Load aliases for this patient (used by the partial-payment dialog to match prior-month events)
  const { data: patientAliases = [] } = useQuery({
    queryKey: ["event-aliases-for-patient", billing.patient.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("event_aliases")
        .select("event_name")
        .eq("patient_id", billing.patient.id);
      if (error) throw error;
      return (data || []).map((a: any) => a.event_name as string);
    },
    enabled: partialDialogOpen,
  });

  const saveExtraPayment = async (addAmount: number) => {
    if (!user || addAmount <= 0) return;
    setSavingExtra(true);
    try {
      const newAmount = (payment?.amount ?? 0) + addAmount;
      const newAllPaid = newAmount >= billing.total;
      if (payment) {
        await supabase
          .from("payments")
          .update({
            amount: newAmount,
            paid: newAllPaid,
            paid_at: new Date().toISOString(),
          })
          .eq("id", payment.id);
      } else {
        await supabase.from("payments").insert({
          therapist_id: user.id,
          patient_id: billing.patient.id,
          month: currentMonth,
          amount: newAmount,
          total_billed: billing.total,
          session_count: 0,
          paid: newAllPaid,
          paid_at: new Date().toISOString(),
          paid_event_ids: [],
        });
      }
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      setExtraInput("");
      toast({ title: `נוסף תשלום של ₪${addAmount}` });
    } catch (error: any) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    } finally {
      setSavingExtra(false);
    }
  };

  const clearExtraPayment = async () => {
    if (!payment || extraPaid <= 0) return;
    setSavingExtra(true);
    try {
      await supabase
        .from("payments")
        .update({
          amount: sessionsPaidAmount,
          paid: sessionsPaidAmount >= billing.total && billing.sessions.length > 0,
        })
        .eq("id", payment.id);
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      toast({ title: "השלמת התשלום בוטלה" });
    } catch (error: any) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    } finally {
      setSavingExtra(false);
    }
  };

  // Manual debts: list of one-off debts (e.g. from previous years)
  const [newDebtAmount, setNewDebtAmount] = useState("");
  const [newDebtNote, setNewDebtNote] = useState("");
  const [savingNewDebt, setSavingNewDebt] = useState(false);
  const [showAddDebt, setShowAddDebt] = useState(false);
  const [deletingDebtId, setDeletingDebtId] = useState<string | null>(null);

  const addManualDebt = async () => {
    if (!user) return;
    const amount = parseFloat(newDebtAmount);
    if (isNaN(amount) || amount <= 0) return;
    setSavingNewDebt(true);
    try {
      await supabase.from("manual_debts").insert({
        therapist_id: user.id,
        patient_id: billing.patient.id,
        amount,
        note: newDebtNote.trim() || null,
      });
      queryClient.invalidateQueries({ queryKey: ["manual-debts"] });
      toast({ title: `נוסף חוב ידני: ₪${amount}` });
      setNewDebtAmount("");
      setNewDebtNote("");
      setShowAddDebt(false);
    } catch (error: any) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    } finally {
      setSavingNewDebt(false);
    }
  };

  const deleteManualDebt = async (debtId: string) => {
    setDeletingDebtId(debtId);
    try {
      await supabase.from("manual_debts").delete().eq("id", debtId);
      queryClient.invalidateQueries({ queryKey: ["manual-debts"] });
      toast({ title: "החוב הידני הוסר" });
    } catch (error: any) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    } finally {
      setDeletingDebtId(null);
    }
  };

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
      const newAmount = billing.sessions
        .filter(s => s.eventId && newPaidIds.includes(s.eventId))
        .reduce((sum, s) => sum + (s.sessionPrice ?? billing.patient.session_price), 0);
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
                colorId: isPaidNow ? null : "3", // toggle: paid→default(no color), unpaid→purple
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
  // Save custom price override for a session
  const saveSessionPrice = async (session: Session) => {
    if (!session.eventId || !user) return;
    const newPrice = parseFloat(editPriceValue);
    if (isNaN(newPrice) || newPrice < 0) return;
    try {
      const defaultPrice = session.sessionPrice ?? billing.patient.session_price;
      if (newPrice === defaultPrice) {
        // Remove override if same as default
        await supabase
          .from("session_overrides")
          .delete()
          .eq("event_id", session.eventId)
          .eq("therapist_id", user.id);
      } else {
        // Upsert override
        await supabase
          .from("session_overrides")
          .upsert(
            {
              therapist_id: user.id,
              patient_id: billing.patient.id,
              event_id: session.eventId,
              custom_price: newPrice,
            },
            { onConflict: "event_id,therapist_id" }
          );
      }
      queryClient.invalidateQueries({ queryKey: ["session-overrides"] });
      queryClient.invalidateQueries({ queryKey: ["google-calendar-events-billing"] });
      toast({ title: "מחיר עודכן" });
    } catch (error: any) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    } finally {
      setEditingPriceEventId(null);
    }
  };

  // Mark a prior month's remaining debt as paid
  const togglePriorMonthPaid = async (detail: PriorDebtDetail) => {
    if (!detail.paymentId || !user) return;
    setTogglingPriorMonth(detail.month);
    try {
      // Fetch current payment to get total_billed
      const { data: paymentData } = await supabase
        .from("payments")
        .select("amount, total_billed")
        .eq("id", detail.paymentId)
        .single();

      if (paymentData) {
        await supabase
          .from("payments")
          .update({
            amount: paymentData.total_billed || (paymentData.amount + detail.debt),
            paid: true,
            paid_at: new Date().toISOString(),
          })
          .eq("id", detail.paymentId);
      }

      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["payments-prior-debts"] });
      toast({ title: `חוב מ${formatMonthLabel(detail.month)} סומן כשולם ✓` });
    } catch (error: any) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    } finally {
      setTogglingPriorMonth(null);
    }
  };

  const formatMonthLabel = (m: string) => {
    const [y, mo] = m.split("-");
    const d = new Date(parseInt(y), parseInt(mo) - 1);
    return d.toLocaleDateString("he-IL", { month: "long", year: "numeric" });
  };


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
              body: { eventIds, colorId: markingAsPaid ? "3" : null },
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
      <div className="flex flex-col gap-3 p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-base sm:text-lg">{billing.patient.name}</span>
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
                שולם חלקית (₪{paidAmount}/{billing.total})
              </span>
            )}
            <span className="text-sm text-muted-foreground">
              ({billing.sessions.length} פגישות{billing.childPatients && billing.childPatients.length > 0 ? ` · ${billing.childPatients.length} מטופלים` : ""})
            </span>
            <button
              type="button"
              onClick={() => setFolderPickerOpen(true)}
              title={driveFolderName ? `תיקיית Drive: ${driveFolderName}` : "הגדר תיקיית Drive לסיכומים"}
              className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors ${
                driveFolderId
                  ? "border-green-500/40 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/20"
                  : "border-dashed text-muted-foreground hover:bg-muted"
              }`}
            >
              {driveFolderId ? <Folder className="h-3 w-3" /> : <FolderCog className="h-3 w-3" />}
              <span className="max-w-[140px] truncate">
                {driveFolderName || "הגדר תיקיית Drive"}
              </span>
            </button>
          </div>
          <div className="text-left">
            {(() => {
              const priorDebtTotal =
                priorDebtDetails.reduce((s, d) => s + d.debt, 0) +
                manualDebts.reduce((s, d) => s + Number(d.amount), 0);
              const grandTotal = billing.total + priorDebtTotal;
              const remaining = Math.max(0, grandTotal - paidAmount);
              return (
                <>
                  <span className="font-bold text-lg">₪{remaining}</span>
                  {(priorDebtTotal > 0 || somePaid) && (
                    <div className="text-xs text-muted-foreground">
                      סה״כ: ₪{grandTotal}
                      {priorDebtTotal > 0 && (
                        <> (חודשי ₪{billing.total} + <span className="text-destructive">קודם ₪{priorDebtTotal}</span>)</>
                      )}
                      {somePaid && <> · שולם: ₪{paidAmount}</>}
                    </div>
                  )}
                </>
              );
            })()}
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
            onClick={openWhatsAppRequest}
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
            onClick={() => setInvoiceDialogOpen(true)}
          >
            <FileText className="ml-1 h-4 w-4" />
            הפק חשבונית
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
                    {editingPriceEventId === session.eventId ? (
                      <form
                        onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); saveSessionPrice(session); }}
                        className="flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="text-muted-foreground">₪</span>
                        <Input
                          type="number"
                          value={editPriceValue}
                          onChange={(e) => setEditPriceValue(e.target.value)}
                          className="h-6 w-16 text-xs px-1"
                          dir="ltr"
                          autoFocus
                          onBlur={() => saveSessionPrice(session)}
                        />
                      </form>
                    ) : (
                      <button
                        className="text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingPriceEventId(session.eventId || null);
                          setEditPriceValue(String(session.sessionPrice ?? billing.patient.session_price));
                        }}
                        title="לחץ לשינוי מחיר"
                      >
                        <span>₪{session.sessionPrice ?? billing.patient.session_price}</span>
                        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100" />
                      </button>
                    )}
                    <span className="text-muted-foreground" dir="ltr">
                      {session.date}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRecorderSession(session);
                      }}
                      className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
                      title="הקלט סיכום פגישה"
                      aria-label="הקלט סיכום פגישה"
                    >
                      <Mic className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="flex justify-between pt-2 font-medium border-t mt-2">
              <span>
                {(billing.patient as any).billing_type === "institution" ? `${billing.sessions.length} פגישות (מחירים שונים)` : `${billing.sessions.length} × ₪${billing.patient.session_price}`}
              </span>
              <div className="flex gap-3">
                {somePaid && !allPaid && (
                  <span className="text-green-600 dark:text-green-400">שולם: ₪{paidAmount}</span>
                )}
                <span>סה״כ: ₪{billing.total}</span>
              </div>
            </div>

            {/* Partial payment top-up */}
            <div className="mt-3 pt-3 border-t border-dashed">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                השלמת תשלום (סכום חלקי שלא מתאים בדיוק לפגישות)
              </p>
              {extraPaid > 0 && (
                <div className="flex items-center justify-between text-sm py-1.5 px-2 mb-2 rounded bg-green-50 dark:bg-green-950/20 border border-green-500/30">
                  <span className="text-green-700 dark:text-green-400">
                    ✓ נוסף תשלום ידני של ₪{extraPaid}
                  </span>
                  <button
                    onClick={clearExtraPayment}
                    disabled={savingExtra}
                    className="text-xs text-destructive hover:underline"
                  >
                    בטל
                  </button>
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = parseFloat(extraInput);
                  if (!isNaN(v) && v > 0) {
                    setPendingAmount(v);
                    setPartialDialogOpen(true);
                  }
                }}
                className="flex items-center gap-2"
              >
                <span className="text-sm text-muted-foreground">₪</span>
                <Input
                  type="number"
                  placeholder="סכום נוסף"
                  value={extraInput}
                  onChange={(e) => setExtraInput(e.target.value)}
                  className="h-8 flex-1 text-sm"
                  dir="ltr"
                />
                <Button type="submit" size="sm" disabled={!extraInput}>
                  הוסף
                </Button>
              </form>
            </div>

            {/* Manual debts (one-off, e.g. from previous years) */}
            <div className="mt-3 pt-3 border-t border-dashed">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-muted-foreground">
                  חובות ידניים (משנים קודמות / מחוץ למערכת)
                </p>
                {!showAddDebt && (
                  <button
                    onClick={() => setShowAddDebt(true)}
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    <Plus className="h-3 w-3" />
                    הוסף
                  </button>
                )}
              </div>

              {manualDebts.length > 0 && (
                <div className="space-y-1 mb-2">
                  {manualDebts.map((debt) => (
                    <div
                      key={debt.id}
                      className="flex items-center justify-between text-sm py-1.5 px-2 rounded bg-destructive/5 border border-destructive/30 gap-2"
                    >
                      <div className="flex flex-col flex-1 min-w-0">
                        <span className="font-medium text-destructive">₪{debt.amount}</span>
                        {debt.note && (
                          <span className="text-xs text-muted-foreground truncate">{debt.note}</span>
                        )}
                      </div>
                      <button
                        onClick={() => deleteManualDebt(debt.id)}
                        disabled={deletingDebtId === debt.id}
                        className="text-destructive/60 hover:text-destructive p-1"
                        title="מחק חוב"
                      >
                        {deletingDebtId === debt.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  ))}
                  <div className="flex justify-between text-xs font-medium pt-1">
                    <span className="text-muted-foreground">סה״כ חובות ידניים</span>
                    <span className="text-destructive">
                      ₪{manualDebts.reduce((s, d) => s + Number(d.amount), 0)}
                    </span>
                  </div>
                </div>
              )}

              {showAddDebt && (
                <div className="space-y-2 p-2 rounded border bg-accent/30">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">₪</span>
                    <Input
                      type="number"
                      placeholder="סכום החוב"
                      value={newDebtAmount}
                      onChange={(e) => setNewDebtAmount(e.target.value)}
                      className="h-8 flex-1 text-sm"
                      dir="ltr"
                      autoFocus
                    />
                  </div>
                  <Input
                    placeholder="הערה (לדוג' חוב משנת 2024)"
                    value={newDebtNote}
                    onChange={(e) => setNewDebtNote(e.target.value)}
                    className="h-8 text-sm"
                  />
                  <div className="flex gap-2 justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setShowAddDebt(false);
                        setNewDebtAmount("");
                        setNewDebtNote("");
                      }}
                      disabled={savingNewDebt}
                    >
                      בטל
                    </Button>
                    <Button size="sm" onClick={addManualDebt} disabled={savingNewDebt || !newDebtAmount}>
                      {savingNewDebt ? <Loader2 className="h-3 w-3 animate-spin" /> : "שמור"}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Prior months debt section */}
            {(priorDebtDetails.length > 0 || manualDebts.length > 0) && (
              <div className="mt-3 pt-3 border-t border-dashed">
                {priorDebtDetails.length > 0 && (
                  <>
                    <p className="text-xs font-medium text-destructive mb-2">חובות מחודשים קודמים:</p>
                    <div className="space-y-1">
                      {priorDebtDetails.map((detail) => {
                        const isToggling = togglingPriorMonth === detail.month;
                        return (
                          <div
                            key={detail.month}
                            className="flex items-center justify-between text-sm py-1.5 px-2 rounded border-r-4 border-r-destructive bg-destructive/5 cursor-pointer transition-colors hover:bg-destructive/10"
                            onClick={() => togglePriorMonthPaid(detail)}
                          >
                            <div className="flex items-center gap-2">
                              <div className="w-5 h-5 rounded border border-destructive/40 flex items-center justify-center">
                                {isToggling && <Loader2 className="h-3 w-3 animate-spin" />}
                              </div>
                              <span>{formatMonthLabel(detail.month)}</span>
                            </div>
                            <span className="font-medium text-destructive">₪{detail.debt}</span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
                {manualDebts.length > 0 && (
                  <div className={`space-y-1 ${priorDebtDetails.length > 0 ? "mt-2" : ""}`}>
                    {manualDebts.map((debt) => (
                      <div
                        key={`manual-${debt.id}`}
                        className="flex items-center justify-between text-sm py-1.5 px-2 rounded border-r-4 border-r-destructive bg-destructive/5"
                      >
                        <span>ידני{debt.note ? ` (${debt.note})` : ""}</span>
                        <span className="font-medium text-destructive">₪{Number(debt.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex justify-between pt-2 font-medium text-destructive text-sm">
                  <span>סה״כ חוב קודם</span>
                  <span>
                    ₪{priorDebtDetails.reduce((s, d) => s + d.debt, 0) +
                      manualDebts.reduce((s, d) => s + Number(d.amount), 0)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {partialDialogOpen && (
        <PartialPaymentDialog
          open={partialDialogOpen}
          onOpenChange={(o) => {
            setPartialDialogOpen(o);
            if (!o) {
              setExtraInput("");
              setPendingAmount(0);
            }
          }}
          amount={pendingAmount}
          patient={billing.patient}
          currentMonth={currentMonth}
          currentMonthSessions={billing.sessions}
          currentMonthBillingTotal={billing.total}
          currentMonthPayment={
            payment
              ? {
                  id: payment.id,
                  amount: payment.amount,
                  paid_event_ids: payment.paid_event_ids,
                  total_billed: payment.total_billed,
                }
              : undefined
          }
          priorDebtDetails={priorDebtDetails}
          aliasNames={patientAliases}
        />
      )}

      <GreenInvoiceCreateDialog
        open={invoiceDialogOpen}
        onOpenChange={setInvoiceDialogOpen}
        patient={billing.patient}
        sessions={billing.sessions.map((s) => ({
          date: s.date,
          summary: s.summary,
          eventId: s.eventId,
          calendarId: s.calendarId,
          startISO: s.startISO,
          sessionPrice: s.sessionPrice,
          isPaidPending: (s as any).isPaidPending,
        }))}
      />

      <SessionNoteRecorderDialog
        open={!!recorderSession}
        onOpenChange={(o) => { if (!o) setRecorderSession(null); }}
        patientId={billing.patient.id}
        patientName={recorderSession?.childPatientName || billing.patient.name}
        sessionDate={recorderSession?.date || ""}
        eventId={recorderSession?.eventId}
        calendarId={recorderSession?.calendarId}
        driveFolderId={driveFolderId}
        driveFolderName={driveFolderName}
        onSummarySaved={() => {
          queryClient.invalidateQueries({ queryKey: ["session-summaries"] });
          queryClient.invalidateQueries({ queryKey: ["google-calendar-events-billing"] });
        }}
        onFolderUpdated={() => {
          queryClient.invalidateQueries({ queryKey: ["patients"] });
          queryClient.invalidateQueries({ queryKey: ["google-calendar-events-billing"] });
        }}
      />

      <DriveFolderPickerDialog
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        patientId={billing.patient.id}
        patientName={billing.patient.name}
        currentFolderId={driveFolderId}
        currentFolderName={driveFolderName}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ["patients"] });
          queryClient.invalidateQueries({ queryKey: ["google-calendar-events-billing"] });
        }}
      />
    </div>
  );
};

export default PatientBillingCard;
