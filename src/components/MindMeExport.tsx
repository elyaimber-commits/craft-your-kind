import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { FileDown, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

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
      // Fetch MindMe patients
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

      // Fetch payments for those patients and months
      const { data: payments } = await supabase
        .from("payments")
        .select("patient_id, month, total_billed, amount")
        .in("patient_id", patientIds)
        .in("month", sortedMonths);

      // Build data per patient per month
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

      // Generate PDF (RTL Hebrew)
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

      // Load a font that supports Hebrew - use built-in and handle RTL manually
      // jsPDF doesn't natively support Hebrew well, so we'll use a workaround
      // by reversing Hebrew strings for display
      const reverseHebrew = (text: string) => {
        // Split by numbers/symbols and reverse Hebrew parts
        return text.split("").reverse().join("");
      };

      const title = reverseHebrew("דוח עמלות MindMe");
      const monthsLabel = reverseHebrew(`חודשים: ${sortedMonths.map(formatMonthLabel).join(", ")}`);

      doc.setFontSize(18);
      doc.text(title, doc.internal.pageSize.width - 14, 20, { align: "right" });

      doc.setFontSize(11);
      doc.text(monthsLabel, doc.internal.pageSize.width - 14, 30, { align: "right" });

      // Table
      const tableData = rows.map((r) => [
        `${r.commission}`,
        `${r.gross}`,
        reverseHebrew(r.month),
        reverseHebrew(r.name),
      ]);

      const totalGross = rows.reduce((s, r) => s + r.gross, 0);
      const totalCommission = rows.reduce((s, r) => s + r.commission, 0);

      tableData.push([
        `${totalCommission}`,
        `${totalGross}`,
        "",
        reverseHebrew("סה״כ"),
      ]);

      autoTable(doc, {
        startY: 38,
        head: [[
          reverseHebrew("עמלה (30%)"),
          reverseHebrew("ברוטו"),
          reverseHebrew("חודש"),
          reverseHebrew("מטופל"),
        ]],
        body: tableData,
        styles: {
          halign: "center",
          fontSize: 11,
        },
        headStyles: {
          fillColor: [59, 130, 246],
          halign: "center",
          fontSize: 11,
        },
        columnStyles: {
          0: { halign: "center" },
          1: { halign: "center" },
          2: { halign: "center" },
          3: { halign: "right" },
        },
        didParseCell: (data) => {
          // Bold last row (totals)
          if (data.row.index === tableData.length - 1) {
            data.cell.styles.fontStyle = "bold";
            data.cell.styles.fillColor = [240, 240, 240];
          }
        },
      });

      // Add currency symbol note
      const finalY = (doc as any).lastAutoTable.finalY + 10;
      doc.setFontSize(9);
      doc.text(
        reverseHebrew("* כל הסכומים בשקלים חדשים (₪)"),
        doc.internal.pageSize.width - 14,
        finalY,
        { align: "right" }
      );

      const fileName = `mindme_commission_${sortedMonths[0]}_${sortedMonths[sortedMonths.length - 1]}.pdf`;
      doc.save(fileName);
      toast({ title: "הקובץ הורד בהצלחה" });
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
