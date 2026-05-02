import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { ListChecks, Mic, Receipt, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  normalizeName,
  findMatchingPatient,
  deriveEventStatus,
  CANCELLED_COLOR_ID,
  type PatientLite,
} from "@/lib/patient-matching";
import SessionNoteRecorderDialog from "./SessionNoteRecorderDialog";
import GreenInvoiceCreateDialog from "./GreenInvoiceCreateDialog";
import DriveFolderPickerDialog from "./DriveFolderPickerDialog";

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

const SessionsToHandle = ({ patients }: { patients: Patient[] }) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"all" | "no_summary" | "no_payment" | "no_invoice">(
    "all",
  );
  const [recorderRow, setRecorderRow] = useState<ToHandleRow | null>(null);
  const [folderPickerRow, setFolderPickerRow] = useState<ToHandleRow | null>(null);
  const [invoiceRow, setInvoiceRow] = useState<ToHandleRow | null>(null);
  const [recoloring, setRecoloring] = useState(false);

  // Calendar events: pull last ~30 days through google-calendar-billing for each of the
  // last two months (current + previous) so we cover end-of-month edge cases.
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
        for (const e of events) {
          calendarsSet.set(e.id, e);
        }
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
    const cutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days back

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

      const match = findMatchingPatient(name, patients, aliasMap);
      if (!match) continue;

      const { summarized, paid, invoiced } = deriveEventStatus({
        colorId: ev.colorId,
        summarizedInDb: summarizedSet.has(ev.id),
        paidInDb: paidEventSet.has(ev.id),
        invoicedInDb: invoicedEventSet.has(ev.id),
      });

      // Skip fully-handled rows
      if (summarized && paid && (invoiced || match.patient.skip_green_invoice)) continue;

      // Resolve calendarId from organizer email (Google returns the calendar's own
      // email here when fetched via calendarList loop in google-calendar-billing).
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

  if (loadingCal) {
    return (
      <Card>
        <CardContent className="py-6 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> טוען פגישות...
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <ListChecks className="h-5 w-5 text-primary" />
            פגישות לטיפול
            <Badge variant="secondary">{filtered.length}</Badge>
          </CardTitle>
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
              variant="ghost"
              size="sm"
              onClick={triggerRecolor}
              disabled={recoloring || rows.length === 0}
              title="עדכן צבעים ביומן"
            >
              <RefreshCw className={`h-4 w-4 ${recoloring ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <CheckCircle2 className="h-8 w-8 text-green-500" />
            הכל מטופל. אין פגישות שמחכות לפעולה.
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((row) => (
              <div
                key={row.eventId}
                className="rounded-lg border bg-card/60 p-3 space-y-2"
              >
                <div className="flex items-start justify-between flex-wrap gap-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{row.patient.name}</div>
                    <div className="text-xs text-muted-foreground" dir="ltr">
                      {row.dateLabel}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-wrap text-[11px]">
                    <Badge variant={row.summarized ? "default" : "outline"} className="gap-1">
                      {row.summarized ? "✓" : "✗"} סיכום
                    </Badge>
                    <Badge variant={row.paid ? "default" : "outline"} className="gap-1">
                      {row.paid ? "✓" : "✗"} תשלום
                    </Badge>
                    {!row.patient.skip_green_invoice && (
                      <Badge variant={row.invoiced ? "default" : "outline"} className="gap-1">
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
          </div>
        )}
      </CardContent>

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
            // Re-open the recorder for the same row after folder selection
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
    </Card>
  );
};

export default SessionsToHandle;
