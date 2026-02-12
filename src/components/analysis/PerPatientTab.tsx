import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronUp, Download, Info, Search } from "lucide-react";
import type { PatientAnalysis } from "@/hooks/useAnalysisData";

interface PerPatientTabProps {
  patientAnalyses: PatientAnalysis[];
  month: string;
  vatRate: number;
  includeRefunds: boolean;
}

function fmt(n: number) {
  return `₪${n.toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

const normalizeName = (name: string): string =>
  name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()
    .replace(/[\u0591-\u05C7]/g, "").replace(/(.)\1+/g, "$1");

export default function PerPatientTab({ patientAnalyses, month, vatRate, includeRefunds }: PerPatientTabProps) {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Fetch calendar events for session dates
  const { data: calendarData } = useQuery({
    queryKey: ["google-calendar-events-billing", month],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const res = await supabase.functions.invoke("google-calendar-billing", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { month },
      });
      if (res.error) throw res.error;
      return res.data as { events?: { id: string; summary: string; start: { dateTime?: string; date?: string } }[] };
    },
    enabled: !!user,
  });

  // Fetch aliases for matching
  const { data: aliases = [] } = useQuery({
    queryKey: ["event-aliases"],
    queryFn: async () => {
      const { data, error } = await supabase.from("event_aliases").select("*");
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  const aliasMap = new Map<string, string>();
  aliases.forEach((a: any) => aliasMap.set(normalizeName(a.event_name), a.patient_id));

  // Build session dates per patient from calendar events
  const sessionDatesByPatient = new Map<string, string[]>();
  const now = new Date();
  if (calendarData?.events) {
    for (const event of calendarData.events) {
      // Filter out future events that haven't occurred yet
      const eventDate = event.start.dateTime ? new Date(event.start.dateTime) : event.start.date ? new Date(event.start.date) : null;
      if (!eventDate || eventDate > now) continue;

      const normalizedEvent = normalizeName(event.summary || "");
      let matchedPatientId: string | null = null;
      for (const pa of patientAnalyses) {
        if (normalizeName(pa.patient.name) === normalizedEvent) {
          matchedPatientId = pa.patient.id;
          break;
        }
      }
      if (!matchedPatientId) {
        const aliasPatientId = aliasMap.get(normalizedEvent);
        if (aliasPatientId) matchedPatientId = aliasPatientId;
      }
      if (matchedPatientId) {
        const d = eventDate;
        const dateStr = `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`;
        const list = sessionDatesByPatient.get(matchedPatientId) || [];
        list.push(dateStr);
        sessionDatesByPatient.set(matchedPatientId, list);
      }
    }
  }

  const filtered = patientAnalyses.filter((pa) =>
    pa.patient.name.includes(search)
  );

  const totals = {
    gross: filtered.reduce((s, pa) => s + pa.gross, 0),
    vat: filtered.reduce((s, pa) => s + pa.vat, 0),
    base: filtered.reduce((s, pa) => s + pa.base, 0),
    commission: filtered.reduce((s, pa) => s + pa.commission, 0),
    net: filtered.reduce((s, pa) => s + pa.netAfterCommission, 0),
  };

  const exportCSV = () => {
    const header = "שם,ברוטו,מעמ,בסיס אחרי מעמ,עמלה,נטו אחרי עמלה\n";
    const rows = patientAnalyses
      .map((pa) =>
        [pa.patient.name, pa.gross, pa.vat.toFixed(0), pa.base.toFixed(0), pa.commission.toFixed(0), pa.netAfterCommission.toFixed(0)].join(",")
      )
      .join("\n");
    const bom = "\uFEFF";
    const blob = new Blob([bom + header + rows], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `analysis_${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const commissionPatients = filtered.filter((pa) => pa.patient.commission_enabled && pa.commission > 0);
  const commissionTotals = {
    gross: commissionPatients.reduce((s, pa) => s + pa.gross, 0),
    base: commissionPatients.reduce((s, pa) => s + pa.base, 0),
    commission: commissionPatients.reduce((s, pa) => s + pa.commission, 0),
    net: commissionPatients.reduce((s, pa) => s + pa.netAfterCommission, 0),
  };

  if (patientAnalyses.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Info className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
          <p className="text-muted-foreground">אין תשלומים בחודש הנבחר</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center justify-between">
        <div className="relative w-full sm:w-64">
          <Search className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="חיפוש מטופל..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pr-9"
          />
        </div>
        <Button variant="outline" size="sm" onClick={exportCSV}>
          <Download className="ml-2 h-4 w-4" />
          ייצוא CSV
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        מסים מחושבים על סך החודש, לא מחולקים למטופלים
      </p>

      <div className="rounded-lg border overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right">שם מטופל</TableHead>
              <TableHead className="text-right">ברוטו</TableHead>
              <TableHead className="text-right">עמלה</TableHead>
              <TableHead className="text-right">מע״מ</TableHead>
              <TableHead className="text-right">בסיס</TableHead>
              <TableHead className="text-right">נטו</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((pa) => (
              <>
                <TableRow key={pa.patient.id} className="cursor-pointer" onClick={() => setExpandedId(expandedId === pa.patient.id ? null : pa.patient.id)}>
                  <TableCell className="font-medium">{pa.patient.name}</TableCell>
                  <TableCell>{fmt(pa.gross)}</TableCell>
                  <TableCell>{pa.commission > 0 ? fmt(pa.commission) : "—"}</TableCell>
                  <TableCell>{fmt(pa.vat)}</TableCell>
                  <TableCell>{fmt(pa.base)}</TableCell>
                  <TableCell className="font-semibold">{fmt(pa.netAfterCommission)}</TableCell>
                  <TableCell>
                    {expandedId === pa.patient.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </TableCell>
                </TableRow>
                {expandedId === pa.patient.id && (
                  <TableRow key={`${pa.patient.id}-detail`}>
                    <TableCell colSpan={7} className="bg-muted/30 p-4">
                      <div className="space-y-1 text-sm">
                        <p className="font-medium mb-2">פירוט תשלומים:</p>
                        {pa.payments.map((pay) => (
                          <div key={pay.id} className="flex justify-between items-center py-1 border-b border-border/50 last:border-0">
                            <span dir="ltr" className="text-muted-foreground">
                              {pay.paid_at ? new Date(pay.paid_at).toLocaleDateString("he-IL") : "—"}
                            </span>
                            <div className="flex items-center gap-2">
                              {includeRefunds && pay.status !== "paid" && (
                                <span className="text-xs bg-destructive/10 text-destructive px-2 py-0.5 rounded">
                                  {pay.status === "refunded" ? "זיכוי" : "ביטול"}
                                </span>
                              )}
                              <span className="font-mono">{fmt(pay.amount)}</span>
                            </div>
                          </div>
                        ))}
                        {pa.patient.commission_enabled && pa.patient.commission_value != null && (
                          <p className="text-xs text-muted-foreground mt-2">
                            עמלה: {pa.patient.commission_type === "percent" ? `${pa.patient.commission_value}%` : fmt(pa.patient.commission_value)} 
                          </p>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
            {filtered.length > 1 && (
              <TableRow className="bg-muted/50 font-semibold">
                <TableCell>סה״כ</TableCell>
                <TableCell>{fmt(totals.gross)}</TableCell>
                <TableCell>{totals.commission > 0 ? fmt(totals.commission) : "—"}</TableCell>
                <TableCell>{fmt(totals.vat)}</TableCell>
                <TableCell>{fmt(totals.base)}</TableCell>
                <TableCell>{fmt(totals.net)}</TableCell>
                <TableCell></TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {commissionPatients.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">מטופלים עם עמלה</h3>
          <div className="rounded-lg border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">שם מטופל</TableHead>
                  <TableHead className="text-right">ברוטו</TableHead>
                  <TableHead className="text-right">אחוז/סכום</TableHead>
                  <TableHead className="text-right">עמלה</TableHead>
                  <TableHead className="text-right">בסיס</TableHead>
                  <TableHead className="text-right">נטו</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commissionPatients.map((pa) => (
                  <TableRow key={pa.patient.id}>
                    <TableCell className="font-medium">{pa.patient.name}</TableCell>
                    <TableCell>{fmt(pa.gross)}</TableCell>
                    <TableCell>
                      {pa.patient.commission_type === "percent"
                        ? `${pa.patient.commission_value}%`
                        : fmt(pa.patient.commission_value || 0)}
                    </TableCell>
                    <TableCell>{fmt(pa.commission)}</TableCell>
                    <TableCell>{fmt(pa.base)}</TableCell>
                    <TableCell className="font-semibold">{fmt(pa.netAfterCommission)}</TableCell>
                  </TableRow>
                ))}
                {commissionPatients.length > 1 && (
                  <TableRow className="bg-muted/50 font-semibold">
                    <TableCell>סה״כ</TableCell>
                    <TableCell>{fmt(commissionTotals.gross)}</TableCell>
                    <TableCell></TableCell>
                    <TableCell>{fmt(commissionTotals.commission)}</TableCell>
                    <TableCell>{fmt(commissionTotals.base)}</TableCell>
                    <TableCell>{fmt(commissionTotals.net)}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {commissionPatients.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">פירוט תשלומים ועמלות</h3>
          <div className="rounded-lg border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">שם מטופל</TableHead>
                  <TableHead className="text-right">תאריכי פגישות</TableHead>
                  <TableHead className="text-right">סכום</TableHead>
                  <TableHead className="text-right">עמלה</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commissionPatients.map((pa) => {
                  const dates = sessionDatesByPatient.get(pa.patient.id) || [];
                  return (
                    <TableRow key={pa.patient.id}>
                      <TableCell className="font-medium">{pa.patient.name}</TableCell>
                      <TableCell dir="ltr" className="text-right">
                        {dates.length > 0 ? dates.join(", ") : "—"}
                      </TableCell>
                      <TableCell>{fmt(pa.gross)}</TableCell>
                      <TableCell>{fmt(pa.commission)}</TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="bg-muted/50 font-semibold">
                  <TableCell>סה״כ</TableCell>
                  <TableCell></TableCell>
                  <TableCell>{fmt(commissionTotals.gross)}</TableCell>
                  <TableCell>{fmt(commissionTotals.commission)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
