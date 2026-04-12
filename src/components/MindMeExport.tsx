import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { FileDown, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const MONTH_NAMES_HE = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

function formatMonthLabel(m: string) {
  const [y, mo] = m.split("-");
  return `${MONTH_NAMES_HE[parseInt(mo) - 1]} ${y}`;
}

function getLast12Months(): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

function buildPrintHTML(
  rows: { name: string; month: string; gross: number; commission: number }[],
  sortedMonths: string[]
) {
  const totalGross = rows.reduce((s, r) => s + r.gross, 0);
  const totalCommission = rows.reduce((s, r) => s + r.commission, 0);

  const tableRows = rows
    .map(
      (r) => `<tr>
        <td>${r.name}</td>
        <td>${r.month}</td>
        <td>${r.gross.toLocaleString()} ₪</td>
        <td>${r.commission.toLocaleString()} ₪</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>דוח עמלות MindMe</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; direction: rtl; padding: 40px; color: #1a1a1a; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    .subtitle { font-size: 13px; color: #555; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th { background: #3b82f6; color: #fff; padding: 10px 12px; text-align: center; font-size: 13px; }
    th:first-child { text-align: right; }
    td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: center; font-size: 13px; }
    td:first-child { text-align: right; }
    tr:last-child td { font-weight: bold; background: #f3f4f6; border-top: 2px solid #d1d5db; }
    .note { font-size: 11px; color: #888; margin-top: 8px; }
    @media print {
      body { padding: 20px; }
      @page { size: A4 portrait; margin: 15mm; }
    }
  </style>
</head>
<body>
  <h1>דוח עמלות MindMe</h1>
  <p class="subtitle">חודשים: ${sortedMonths.map(formatMonthLabel).join(", ")}</p>
  <table>
    <thead>
      <tr>
        <th>מטופל</th>
        <th>חודש</th>
        <th>ברוטו</th>
        <th>עמלה (30%)</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows}
      <tr>
        <td>סה״כ</td>
        <td></td>
        <td>${totalGross.toLocaleString()} ₪</td>
        <td>${totalCommission.toLocaleString()} ₪</td>
      </tr>
    </tbody>
  </table>
  <p class="note">* כל הסכומים בשקלים חדשים (₪)</p>
</body>
</html>`;
}

export default function MindMeExport() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [selectedMonths, setSelectedMonths] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const months = getLast12Months();

  const toggleMonth = (m: string) => {
    setSelectedMonths((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]
    );
  };

  const generate = async () => {
    if (!user || selectedMonths.length === 0) return;
    setGenerating(true);
    try {
      const { data: mindmePatients } = await supabase
        .from("patients")
        .select("id, name")
        .eq("mindme", true);

      if (!mindmePatients || mindmePatients.length === 0) {
        toast({ title: "אין מטופלי MindMe", variant: "destructive" });
        return;
      }

      const patientIds = mindmePatients.map((p) => p.id);
      const sortedMonths = [...selectedMonths].sort();

      const { data: payments } = await supabase
        .from("payments")
        .select("patient_id, month, total_billed, amount")
        .in("patient_id", patientIds)
        .in("month", sortedMonths);

      const rows: { name: string; month: string; gross: number; commission: number }[] = [];

      for (const month of sortedMonths) {
        for (const patient of mindmePatients) {
          const payment = (payments || []).find(
            (p) => p.patient_id === patient.id && p.month === month
          );
          const gross = payment?.total_billed || payment?.amount || 0;
          if (gross > 0) {
            rows.push({
              name: patient.name,
              month: formatMonthLabel(month),
              gross,
              commission: Math.round(gross * 0.3),
            });
          }
        }
      }

      if (rows.length === 0) {
        toast({ title: "אין נתונים לחודשים שנבחרו", variant: "destructive" });
        return;
      }

      // Open print dialog with styled HTML
      const html = buildPrintHTML(rows, sortedMonths);
      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        toast({ title: "חלון הדפסה נחסם", description: "אנא אפשר חלונות קופצים עבור אתר זה", variant: "destructive" });
        return;
      }
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.onload = () => {
        printWindow.print();
      };

      toast({ title: "חלון ההדפסה נפתח - בחר 'שמור כ-PDF'" });
      setOpen(false);
    } catch (error: any) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileDown className="ml-1 h-4 w-4" />
          ייצוא PDF
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm" dir="rtl">
        <DialogHeader>
          <DialogTitle>ייצוא עמלות MindMe</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground mb-3">בחר חודשים לייצוא:</p>
        <div className="grid grid-cols-2 gap-2 max-h-[300px] overflow-y-auto">
          {months.map((m) => (
            <label
              key={m}
              className="flex items-center gap-2 cursor-pointer text-sm p-2 rounded hover:bg-accent transition-colors"
            >
              <Checkbox
                checked={selectedMonths.includes(m)}
                onCheckedChange={() => toggleMonth(m)}
              />
              {formatMonthLabel(m)}
            </label>
          ))}
        </div>
        <Button
          onClick={generate}
          disabled={selectedMonths.length === 0 || generating}
          className="w-full mt-3"
        >
          {generating ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <FileDown className="ml-2 h-4 w-4" />}
          ייצוא {selectedMonths.length > 0 ? `(${selectedMonths.length} חודשים)` : ""}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
