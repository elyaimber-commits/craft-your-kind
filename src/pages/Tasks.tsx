import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowRight,
  ListChecks,
  Mic,
  Receipt,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  MessageCircle,
  Check,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  normalizeName,
  findMatchingPatient,
  deriveEventStatus,
  CANCELLED_COLOR_ID,
  type PatientLite,
} from "@/lib/patient-matching";
import SessionNoteRecorderDialog from "@/components/SessionNoteRecorderDialog";
import GreenInvoiceCreateDialog from "@/components/GreenInvoiceCreateDialog";
import DriveFolderPickerDialog from "@/components/DriveFolderPickerDialog";

interface Patient extends PatientLite {
  phone: string;
  session_price: number;
  drive_folder_id?: string | null;
  drive_folder_name?: string | null;
  skip_green_invoice?: boolean;
  green_invoice_customer_id?: string | null;
}

interface CalendarEvent {
  id: string;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  colorId?: string;
  organizer?: { email?: string };
}

interface ToHandleRow {
  eventId: string;
  calendarId: string;
  patient: Patient;
  startISO: string;
  dateLabel: string;
  summarized: boolean;
  paid: boolean;
  invoiced: boolean;
  sessionPrice: number;
}

const dayNames = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  const day = dayNames[d.getDay()];
  const formatted = new Intl.DateTimeFormat("he-IL", {
    day: "numeric",
    month: "numeric",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  }).format(d);
  return `${day} ${formatted}`;
};

const Tasks = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<
    "all" | "no_summary" | "no_payment" | "no_invoice"
  >("all");
  const [recorderRow, setRecorderRow] = useState<ToHandleRow | null>(null);
  const [folderPickerRow, setFolderPickerRow] = useState<ToHandleRow | null>(null);
  const [invoiceRow, setInvoiceRow] = useState<ToHandleRow | null>(null);
  const [recoloring, setRecoloring] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const { data: patients = [] } = useQuery({
    queryKey: ["patients"],
    queryFn: async () => {
      const { data, error } = await supabase.from("patients").select("*").order("name");
      if (error) throw error;
      return data as Patient[];
    },
  });

  const { data: calData, isLoading: loadingCal } = useQuery({
    queryKey: ["sessions-to-handle-calendar"],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const now = new Date();
      const months: string[] = [];
      for (let i = 0; i < 2; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      }
      const calendarsSet = new Map<string, CalendarEvent>();
      for (const m of months) {
        const res = await supabase.functions.invoke("google-calendar-billing", {
          body: { month: m },
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (res.error) throw res.error;
        const events: any[] = (res.data as any)?.events || [];
        for (const e of events) calendarsSet.set(e.id, e);
      }
      return Array.from(calendarsSet.values());
    },
    enabled: !!user,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const { data: aliases = [] } = useQuery({
    queryKey: ["event-aliases-handle"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("event_aliases")
        .select("event_name, patient_id");
      if (error) throw error;
      return data;
    },
  });

  const { data: ignoredEvents = [] } = useQuery({
    queryKey: ["ignored-events-handle"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ignored_calendar_events")
        .select("event_name");
      if (error) throw error;
      return data;
    },
  });

  const { data: summaries = [] } = useQuery({
    queryKey: ["session-summaries"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("session_summaries")
        .select("event_id");
      if (error) throw error;
      return data;
    },
  });

  const { data: paymentRows = [] } = useQuery({
    queryKey: ["payments-handle"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("paid_event_ids, external_payment_id");
      if (error) throw error;
      return data;
    },
  });

  const rows = useMemo<ToHandleRow[]>(() => {
    if (!calData) return [];
    const aliasMap = new Map<string, string>();
    for (const a of aliases as any[]) {
      aliasMap.set(normalizeName(a.event_name), a.patient_id);
    }
    const ignoredSet = new Set(
      (ignoredEvents as any[]).map((e) => normalizeName(e.event_name)),
    );
    const summarizedSet = new Set((summaries as any[]).map((s) => s.event_id));
    const paidEventSet = new Set<string>();
    const invoicedEventSet = new Set<string>();
    for (const p of paymentRows as any[]) {
      const ids = (p.paid_event_ids || []) as string[];
      const isInvoiced = !!p.external_payment_id;
      for (const id of ids) {
        paidEventSet.add(id);
        if (isInvoiced) invoicedEventSet.add(id);
      }
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const out: ToHandleRow[] = [];
    for (const ev of calData) {
      if (ev.colorId === CANCELLED_COLOR_ID) continue;
      const startISO = ev.start?.dateTime || ev.start?.date;
      if (!startISO) continue;
      const start = new Date(startISO);
      if (start > now) continue;
      if (start < cutoff) continue;
      const name = (ev.summary || "").trim();
      if (!name) continue;
      if (ignoredSet.has(normalizeName(name))) continue;

      const match = findMatchingPatient(name, patients as Patient[], aliasMap);
      if (!match) continue;

      const { summarized, paid, invoiced } = deriveEventStatus({
        colorId: ev.colorId,
        summarizedInDb: summarizedSet.has(ev.id),
        paidInDb: paidEventSet.has(ev.id),
        invoicedInDb: invoicedEventSet.has(ev.id),
      });

      if (summarized && paid && (invoiced || match.patient.skip_green_invoice)) continue;

      const calendarId = ev.organizer?.email || "primary";
      out.push({
        eventId: ev.id,
        calendarId,
        patient: match.patient,
        startISO,
        dateLabel: fmtDate(startISO),
        summarized,
        paid,
        invoiced,
        sessionPrice: match.patient.session_price,
      });
    }
    out.sort((a, b) => b.startISO.localeCompare(a.startISO));
    return out;
  }, [calData, aliases, ignoredEvents, summaries, paymentRows, patients]);

  const filtered = useMemo(() => {
    if (filter === "no_summary") return rows.filter((r) => !r.summarized);
    if (filter === "no_payment") return rows.filter((r) => !r.paid);
    if (filter === "no_invoice")
      return rows.filter((r) => r.paid && !r.invoiced && !r.patient.skip_green_invoice);
    return rows;
  }, [rows, filter]);

  // Group by patient
  const grouped = useMemo(() => {
    const map = new Map<string, { patient: Patient; rows: ToHandleRow[] }>();
    for (const r of filtered) {
      const g = map.get(r.patient.id);
      if (g) g.rows.push(r);
      else map.set(r.patient.id, { patient: r.patient, rows: [r] });
    }
    // Sort groups by patient name
    return Array.from(map.values()).sort((a, b) =>
      a.patient.name.localeCompare(b.patient.name, "he"),
    );
  }, [filtered]);

  const triggerRecolor = async () => {
    if (rows.length === 0) return;
    setRecoloring(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const { error } = await supabase.functions.invoke("auto-color-events", {
        body: {
          events: rows.map((r) => ({ calendarId: r.calendarId, eventId: r.eventId })),
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      toast({ title: "צבעי היומן עודכנו" });
      queryClient.invalidateQueries({ queryKey: ["sessions-to-handle-calendar"] });
    } catch (e: any) {
      toast({
        title: "עדכון צבעים נכשל",
        description: e?.message || "נסה שוב",
        variant: "destructive",
      });
    } finally {
      setRecoloring(false);
    }
  };

  const buildWhatsAppLink = (patient: Patient, unpaid: ToHandleRow[]) => {
    const dates = unpaid
      .map((r) => {
        const d = new Date(r.startISO);
        return new Intl.DateTimeFormat("he-IL", {
          day: "numeric",
          month: "numeric",
          timeZone: "Asia/Jerusalem",
        }).format(d);
      })
      .join(", ");
    const total = unpaid.reduce((s, r) => s + (r.sessionPrice || 0), 0);
    const message = `היי, מעדכן לגבי תשלום.\nמפגשים: ${dates}\nסה״כ: ₪${total}\nתודה!`;
    const cleanPhone = (patient.phone || "").replace(/\D/g, "");
    if (!cleanPhone) return null;
    const intlPhone = cleanPhone.startsWith("0") ? "972" + cleanPhone.slice(1) : cleanPhone;
    return `https://wa.me/${intlPhone}?text=${encodeURIComponent(message)}`;
  };

  const [markingPaidPatient, setMarkingPaidPatient] = useState<string | null>(null);

  const markPatientUnpaidAsPaid = async (
    patient: Patient,
    unpaid: ToHandleRow[],
  ) => {
    if (!user || unpaid.length === 0) return;
    setMarkingPaidPatient(patient.id);
    try {
      // Group unpaid rows by their YYYY-MM (based on startISO)
      const byMonth = new Map<string, ToHandleRow[]>();
      for (const r of unpaid) {
        const d = new Date(r.startISO);
        const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const arr = byMonth.get(m) || [];
        arr.push(r);
        byMonth.set(m, arr);
      }

      for (const [month, rowsForMonth] of byMonth.entries()) {
        // Fetch existing payment record for this patient/month
        const { data: existing } = await supabase
          .from("payments")
          .select("id, amount, paid_event_ids, total_billed")
          .eq("patient_id", patient.id)
          .eq("month", month)
          .maybeSingle();

        const newEventIds = rowsForMonth.map((r) => r.eventId);
        const addedAmount = rowsForMonth.reduce(
          (s, r) => s + (r.sessionPrice || 0),
          0,
        );

        if (existing) {
          const mergedIds = Array.from(
            new Set([...(existing.paid_event_ids || []), ...newEventIds]),
          );
          const newAmount = (existing.amount || 0) + addedAmount;
          const isAllPaid =
            existing.total_billed != null
              ? newAmount >= existing.total_billed
              : false;
          await supabase
            .from("payments")
            .update({
              amount: newAmount,
              paid_event_ids: mergedIds,
              session_count: mergedIds.length,
              paid: isAllPaid,
              paid_at: new Date().toISOString(),
            })
            .eq("id", existing.id);
        } else {
          await supabase.from("payments").insert({
            therapist_id: user.id,
            patient_id: patient.id,
            month,
            amount: addedAmount,
            session_count: newEventIds.length,
            paid_event_ids: newEventIds,
            paid: false,
            paid_at: new Date().toISOString(),
          });
        }
      }

      // Recolor those events on the calendar
      try {
        const { data: { session: authSession } } = await supabase.auth.getSession();
        if (authSession) {
          await supabase.functions.invoke("auto-color-events", {
            headers: { Authorization: `Bearer ${authSession.access_token}` },
            body: {
              events: unpaid.map((r) => ({
                calendarId: r.calendarId,
                eventId: r.eventId,
              })),
            },
          });
        }
      } catch (e) {
        console.error("Failed to recolor:", e);
      }

      toast({ title: `סומנו ${unpaid.length} פגישות כשולמו` });
      queryClient.invalidateQueries({ queryKey: ["payments-handle"] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["sessions-to-handle-calendar"] });
    } catch (e: any) {
      toast({
        title: "שגיאה בסימון תשלום",
        description: e?.message || "נסה שוב",
        variant: "destructive",
      });
    } finally {
      setMarkingPaidPatient(null);
    }
  };

  const totalCount = filtered.length;

  return (
    <div className="min-h-screen bg-background p-4 md:p-8" dir="rtl">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard")}>
              <ArrowRight className="ml-1 h-4 w-4" />
              חזרה
            </Button>
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground flex items-center gap-2">
              <ListChecks className="h-7 w-7 text-primary" />
              משימות
              <Badge variant="secondary">{totalCount}</Badge>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Select value={filter} onValueChange={(v) => setFilter(v as any)}>
              <SelectTrigger className="w-40 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">הכל</SelectItem>
                <SelectItem value="no_summary">חסר סיכום</SelectItem>
                <SelectItem value="no_payment">חסר תשלום</SelectItem>
                <SelectItem value="no_invoice">חסר חשבונית</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={triggerRecolor}
              disabled={recoloring || rows.length === 0}
              title="עדכן צבעים ביומן"
            >
              <RefreshCw className={`ml-1 h-4 w-4 ${recoloring ? "animate-spin" : ""}`} />
              עדכן צבעים
            </Button>
          </div>
        </div>

        {loadingCal ? (
          <Card>
            <CardContent className="py-10 flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> טוען פגישות...
            </CardContent>
          </Card>
        ) : grouped.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground flex flex-col items-center gap-3">
              <CheckCircle2 className="h-12 w-12 text-green-500" />
              <div className="text-base">הכל מטופל ✨</div>
              <div>אין פגישות שמחכות לפעולה.</div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {grouped.map(({ patient, rows: patientRows }) => {
              const isCollapsed = collapsed[patient.id];
              const unpaidRows = patientRows.filter((r) => !r.paid);
              const counts = {
                summary: patientRows.filter((r) => !r.summarized).length,
                payment: unpaidRows.length,
                invoice: patientRows.filter(
                  (r) => r.paid && !r.invoiced && !r.patient.skip_green_invoice,
                ).length,
              };
              const unpaidAmount = unpaidRows.reduce(
                (sum, r) => sum + (r.sessionPrice || 0),
                0,
              );
              return (
                <Card key={patient.id}>
                  <CardHeader
                    className="pb-3 cursor-pointer"
                    onClick={() =>
                      setCollapsed((c) => ({ ...c, [patient.id]: !c[patient.id] }))
                    }
                  >
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <CardTitle className="flex items-center gap-2 text-base">
                        {isCollapsed ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronUp className="h-4 w-4" />
                        )}
                        {patient.name}
                        <Badge variant="secondary">{patientRows.length}</Badge>
                      </CardTitle>
                      <div className="flex items-center gap-1 flex-wrap text-[11px]">
                        {counts.summary > 0 && (
                          <Badge variant="outline" className="gap-1">
                            <Mic className="h-3 w-3" />
                            {counts.summary} לסיכום
                          </Badge>
                        )}
                        {counts.payment > 0 && (
                          <Badge variant="outline" className="gap-1">
                            {counts.payment} לתשלום (₪{unpaidAmount.toLocaleString("he-IL")})
                          </Badge>
                        )}
                        {counts.invoice > 0 && (
                          <Badge variant="outline" className="gap-1">
                            <Receipt className="h-3 w-3" />
                            {counts.invoice} לחשבונית
                          </Badge>
                        )}
                      </div>
                    </div>
                    {unpaidRows.length > 0 && (
                      <div
                        className="flex flex-wrap gap-2 pt-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          size="sm"
                          onClick={() => {
                            const link = buildWhatsAppLink(patient, unpaidRows);
                            if (!link) {
                              toast({
                                title: "אין מספר טלפון",
                                description: "הוסף מספר טלפון לפציינט/ית",
                                variant: "destructive",
                              });
                              return;
                            }
                            window.open(link, "_blank", "noopener,noreferrer");
                          }}
                        >
                          <MessageCircle className="ml-1 h-4 w-4" />
                          שלח בקשת תשלום (₪
                          {unpaidAmount.toLocaleString("he-IL")})
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={markingPaidPatient === patient.id}
                          onClick={() =>
                            markPatientUnpaidAsPaid(patient, unpaidRows)
                          }
                        >
                          {markingPaidPatient === patient.id ? (
                            <Loader2 className="ml-1 h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="ml-1 h-4 w-4" />
                          )}
                          סמן הכל כשולם
                        </Button>
                      </div>
                    )}
                  </CardHeader>
                  {!isCollapsed && (
                    <CardContent className="space-y-2">
                      {patientRows.map((row) => (
                        <div
                          key={row.eventId}
                          className="rounded-lg border bg-card/60 p-3 space-y-2"
                        >
                          <div className="flex items-start justify-between flex-wrap gap-2">
                            <div className="text-xs text-muted-foreground" dir="ltr">
                              {row.dateLabel}
                            </div>
                            <div className="flex items-center gap-1 flex-wrap text-[11px]">
                              <Badge
                                variant={row.summarized ? "default" : "outline"}
                                className="gap-1"
                              >
                                {row.summarized ? "✓" : "✗"} סיכום
                              </Badge>
                              <Badge
                                variant={row.paid ? "default" : "outline"}
                                className="gap-1"
                              >
                                {row.paid ? "✓" : "✗"} תשלום
                              </Badge>
                              {!row.patient.skip_green_invoice && (
                                <Badge
                                  variant={row.invoiced ? "default" : "outline"}
                                  className="gap-1"
                                >
                                  {row.invoiced ? "✓" : "✗"} חשבונית
                                </Badge>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {!row.summarized && (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  if (!row.patient.drive_folder_id) {
                                    setFolderPickerRow(row);
                                  } else {
                                    setRecorderRow(row);
                                  }
                                }}
                              >
                                <Mic className="ml-1 h-3 w-3" /> סכם
                              </Button>
                            )}
                            {row.paid && !row.invoiced && !row.patient.skip_green_invoice && (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setInvoiceRow(row)}
                              >
                                <Receipt className="ml-1 h-3 w-3" /> הפק חשבונית
                              </Button>
                            )}
                            {!row.paid && (
                              <span className="text-xs text-muted-foreground self-center">
                                ימתין לתשלום (חודשי / Green Invoice)
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {recorderRow && (
        <SessionNoteRecorderDialog
          open={!!recorderRow}
          onOpenChange={(o) => { if (!o) setRecorderRow(null); }}
          patientId={recorderRow.patient.id}
          patientName={recorderRow.patient.name}
          sessionDate={recorderRow.dateLabel}
          eventId={recorderRow.eventId}
          calendarId={recorderRow.calendarId}
          driveFolderId={recorderRow.patient.drive_folder_id}
          driveFolderName={recorderRow.patient.drive_folder_name}
          onSummarySaved={() => {
            queryClient.invalidateQueries({ queryKey: ["session-summaries"] });
            queryClient.invalidateQueries({ queryKey: ["sessions-to-handle-calendar"] });
          }}
          onFolderUpdated={() => {
            queryClient.invalidateQueries({ queryKey: ["patients"] });
          }}
        />
      )}

      {folderPickerRow && (
        <DriveFolderPickerDialog
          open={!!folderPickerRow}
          onOpenChange={(o) => { if (!o) setFolderPickerRow(null); }}
          patientId={folderPickerRow.patient.id}
          patientName={folderPickerRow.patient.name}
          currentFolderId={folderPickerRow.patient.drive_folder_id}
          currentFolderName={folderPickerRow.patient.drive_folder_name}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["patients"] });
            const r = folderPickerRow;
            setFolderPickerRow(null);
            setTimeout(() => setRecorderRow(r), 50);
          }}
        />
      )}

      {invoiceRow && (
        <GreenInvoiceCreateDialog
          open={!!invoiceRow}
          onOpenChange={(o) => { if (!o) setInvoiceRow(null); }}
          patient={invoiceRow.patient as any}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ["payments-handle"] });
            queryClient.invalidateQueries({ queryKey: ["sessions-to-handle-calendar"] });
          }}
          sessions={[
            {
              date: invoiceRow.dateLabel,
              summary: invoiceRow.patient.name,
              eventId: invoiceRow.eventId,
              calendarId: invoiceRow.calendarId,
              startISO: invoiceRow.startISO,
              sessionPrice: invoiceRow.sessionPrice,
              isPaidPending: true,
            },
          ]}
        />
      )}
    </div>
  );
};

export default Tasks;
