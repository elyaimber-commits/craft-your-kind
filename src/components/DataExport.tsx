import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Download, Loader2 } from "lucide-react";

const DataExport = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);

  const exportData = async (format: "csv" | "json") => {
    if (!user) return;
    setExporting(true);
    try {
      const [patientsRes, paymentsRes] = await Promise.all([
        supabase.from("patients").select("*").order("name"),
        supabase.from("payments").select("*").order("month", { ascending: false }),
      ]);

      if (patientsRes.error) throw patientsRes.error;
      if (paymentsRes.error) throw paymentsRes.error;

      const patients = patientsRes.data;
      const payments = paymentsRes.data;

      if (format === "json") {
        const blob = new Blob(
          [JSON.stringify({ patients, payments }, null, 2)],
          { type: "application/json" }
        );
        downloadBlob(blob, `backup-${new Date().toISOString().slice(0, 10)}.json`);
      } else {
        // CSV: patients
        const patientsCsv = toCsv(patients, ["name", "phone", "session_price", "billing_type"]);
        const paymentsCsv = toCsv(
          payments.map((p: any) => ({
            ...p,
            patient_name: patients.find((pt: any) => pt.id === p.patient_id)?.name || "",
          })),
          ["patient_name", "month", "amount", "session_count", "paid"]
        );

        const csvContent = `מטופלים\n${patientsCsv}\n\nתשלומים\n${paymentsCsv}`;
        const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8" });
        downloadBlob(blob, `backup-${new Date().toISOString().slice(0, 10)}.csv`);
      }

      toast({ title: "הגיבוי הורד בהצלחה" });
    } catch (error: any) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => exportData("csv")} disabled={exporting}>
        {exporting ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Download className="ml-1 h-4 w-4" />}
        ייצוא CSV
      </Button>
      <Button variant="outline" size="sm" onClick={() => exportData("json")} disabled={exporting}>
        {exporting ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Download className="ml-1 h-4 w-4" />}
        ייצוא JSON
      </Button>
    </div>
  );
};

function toCsv(data: any[], columns: string[]): string {
  const header = columns.join(",");
  const rows = data.map((row) =>
    columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) return "";
      const str = String(val);
      return str.includes(",") || str.includes('"') || str.includes("\n")
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    }).join(",")
  );
  return [header, ...rows].join("\n");
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default DataExport;
