import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Copy, AlertTriangle, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface DeductionResult {
  name: string;
  amount: number;
}

interface SummaryTabProps {
  month: string;
  totalGross: number;
  totalVAT: number;
  monthBaseAfterVAT: number;
  deductionResults: DeductionResult[];
  commissionsTotal: number;
  net: number;
  paymentCount: number;
  totalRefundCount: number;
  totalRefundAmount: number;
  includeRefunds: boolean;
  setIncludeRefunds: (v: boolean) => void;
  netAfterRefunds: boolean;
  setNetAfterRefunds: (v: boolean) => void;
  vatRate: number;
  hasPayments: boolean;
}

function fmt(n: number) {
  return `₪${n.toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export default function SummaryTab({
  month,
  totalGross,
  totalVAT,
  monthBaseAfterVAT,
  deductionResults,
  commissionsTotal,
  net,
  paymentCount,
  totalRefundCount,
  totalRefundAmount,
  includeRefunds,
  setIncludeRefunds,
  netAfterRefunds,
  setNetAfterRefunds,
  vatRate,
  hasPayments,
}: SummaryTabProps) {
  const { toast } = useToast();

  if (!hasPayments) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Info className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
          <p className="text-muted-foreground">אין תשלומים בחודש הנבחר</p>
        </CardContent>
      </Card>
    );
  }

  const copySummary = () => {
    const deductionsText = deductionResults
      .map((d) => `${d.name} ${fmt(d.amount)}`)
      .join(", ");
    const text = `חודש ${month}: ברוטו ${fmt(totalGross)}, מע״מ ${fmt(totalVAT)}, בסיס ${fmt(monthBaseAfterVAT)}, ${deductionsText}, עמלות ${fmt(commissionsTotal)}, נטו ${fmt(net)}`;
    navigator.clipboard.writeText(text);
    toast({ title: "הועתק ללוח" });
  };

  return (
    <div className="space-y-4">
      {/* Warnings */}
      {vatRate !== 17 && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950 p-3 text-sm">
          <Info className="h-4 w-4 text-blue-600" />
          <span>שיעור מע״מ שונה מ-17% ({vatRate}%)</span>
        </div>
      )}
      {net < 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          <span>הנטו שלילי!</span>
        </div>
      )}
      {deductionResults.some((d) => d.amount > monthBaseAfterVAT * 0.6) && (
        <div className="flex items-center gap-2 rounded-lg border border-yellow-300 bg-yellow-50 dark:border-yellow-700 dark:bg-yellow-950 p-3 text-sm">
          <AlertTriangle className="h-4 w-4 text-yellow-600" />
          <span>אחד הניכויים עולה על 60% מהבסיס</span>
        </div>
      )}

      {/* Refund toggles */}
      <div className="flex flex-wrap gap-6 items-center">
        <div className="flex items-center gap-2">
          <Switch checked={includeRefunds} onCheckedChange={setIncludeRefunds} id="include-refunds" />
          <Label htmlFor="include-refunds" className="text-sm">כלול זיכויים/ביטולים</Label>
        </div>
        {includeRefunds && (
          <div className="flex items-center gap-2">
            <Switch checked={netAfterRefunds} onCheckedChange={setNetAfterRefunds} id="net-refunds" />
            <Label htmlFor="net-refunds" className="text-sm">נטו אחרי זיכויים</Label>
          </div>
        )}
      </div>

      {/* Big NET number */}
      <Card className="border-2 border-primary/30">
        <CardContent className="py-6 text-center">
          <p className="text-sm text-muted-foreground mb-1">נטו אחרי הכל</p>
          <p className={`text-4xl font-bold ${net < 0 ? "text-destructive" : "text-primary"}`}>
            {fmt(net)}
          </p>
        </CardContent>
      </Card>

      {/* Breakdown */}
      <Card>
        <CardContent className="py-4 space-y-3">
          <Row label="ברוטו בחודש" value={fmt(totalGross)} sub={`${paymentCount} תשלומים`} />
          {includeRefunds && totalRefundCount > 0 && (
            <Row label="זיכויים/ביטולים" value={`-${fmt(totalRefundAmount)}`} sub={`${totalRefundCount} פריטים`} destructive />
          )}
          <Row label={`מע״מ (מתוך הברוטו, ${vatRate}%)`} value={fmt(totalVAT)} />
          <Row label="בסיס אחרי מע״מ" value={fmt(monthBaseAfterVAT)} bold />
          <hr className="border-border" />
          {deductionResults.map((d) => (
            <Row key={d.name} label={d.name} value={fmt(d.amount)} />
          ))}
          <Row label="עמלות לפי מטופל (סה״כ)" value={fmt(commissionsTotal)} />
          <hr className="border-border" />
          <Row label="נטו אחרי הכל" value={fmt(net)} bold />
        </CardContent>
      </Card>

      <Button variant="outline" size="sm" onClick={copySummary}>
        <Copy className="ml-2 h-4 w-4" />
        העתק סיכום
      </Button>
    </div>
  );
}

function Row({ label, value, sub, bold, destructive }: { label: string; value: string; sub?: string; bold?: boolean; destructive?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <span className={`text-sm ${bold ? "font-bold" : ""}`}>{label}</span>
        {sub && <span className="text-xs text-muted-foreground mr-2">({sub})</span>}
      </div>
      <span className={`text-sm font-mono ${bold ? "font-bold" : ""} ${destructive ? "text-destructive" : ""}`}>{value}</span>
    </div>
  );
}
