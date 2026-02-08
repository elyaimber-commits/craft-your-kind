import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowRight } from "lucide-react";
import {
  useMonthPayments,
  useAnalysisPatients,
  computeAnalysis,
  getStoredDeductions,
  storeDeductions,
  getStoredVatRate,
  storeVatRate,
  type GlobalDeduction,
} from "@/hooks/useAnalysisData";
import SummaryTab from "@/components/analysis/SummaryTab";
import PerPatientTab from "@/components/analysis/PerPatientTab";
import SettingsTab from "@/components/analysis/SettingsTab";

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthHebrew(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1).toLocaleDateString("he-IL", { month: "long", year: "numeric" });
}

export default function Analysis() {
  const navigate = useNavigate();
  const [month, setMonth] = useState(getCurrentMonth);
  const [vatRate, setVatRateState] = useState(getStoredVatRate);
  const [deductions, setDeductionsState] = useState<GlobalDeduction[]>(getStoredDeductions);
  const [includeRefunds, setIncludeRefunds] = useState(false);
  const [netAfterRefunds, setNetAfterRefunds] = useState(false);

  const setVatRate = useCallback((v: number) => {
    setVatRateState(v);
    storeVatRate(v);
  }, []);

  const setDeductions = useCallback((d: GlobalDeduction[]) => {
    setDeductionsState(d);
    storeDeductions(d);
  }, []);

  const { data: payments = [], isLoading: loadingPayments, debugMonth } = useMonthPayments(month);
  const { data: patients = [], isLoading: loadingPatients } = useAnalysisPatients();

  const analysis = useMemo(
    () => computeAnalysis(payments, patients, vatRate, deductions, includeRefunds, netAfterRefunds),
    [payments, patients, vatRate, deductions, includeRefunds, netAfterRefunds]
  );

  const isLoading = loadingPayments || loadingPatients;

  return (
    <div className="min-h-screen bg-background p-4 md:p-8" dir="rtl">
      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
              <ArrowRight className="h-5 w-5" />
            </Button>
            <h1 className="text-2xl sm:text-3xl font-bold">📊 ניתוח חודשי</h1>
          </div>
        </div>

        {/* Month selector */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            dir="ltr"
          />
          <Button variant="outline" size="sm" onClick={() => setMonth(shiftMonth(month, -1))}>
            חודש קודם
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMonth(getCurrentMonth())}>
            החודש
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMonth(shiftMonth(month, 1))}>
            חודש הבא
          </Button>
        </div>

        <p className="text-sm text-muted-foreground mb-2">
          {formatMonthHebrew(month)} — החישוב מבוסס על תשלומים ששויכו לחודש הנבחר
        </p>
        <p className="text-xs text-muted-foreground mb-4 font-mono" dir="ltr">
          Debug: month={debugMonth} | payments: {payments.length}
        </p>

        {isLoading ? (
          <p className="text-muted-foreground text-center py-12">טוען...</p>
        ) : (
          <Tabs defaultValue="summary" className="space-y-4">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="summary">סיכום</TabsTrigger>
              <TabsTrigger value="patients">לפי מטופל</TabsTrigger>
              <TabsTrigger value="settings">הגדרות</TabsTrigger>
            </TabsList>

            <TabsContent value="summary">
              <SummaryTab
                month={month}
                totalGross={analysis.totalGross}
                totalVAT={analysis.totalVAT}
                monthBaseAfterVAT={analysis.monthBaseAfterVAT}
                deductionResults={analysis.deductionResults}
                commissionsTotal={analysis.commissionsTotal}
                net={analysis.net}
                paymentCount={analysis.paymentCount}
                totalRefundCount={analysis.totalRefundCount}
                totalRefundAmount={analysis.totalRefundAmount}
                includeRefunds={includeRefunds}
                setIncludeRefunds={setIncludeRefunds}
                netAfterRefunds={netAfterRefunds}
                setNetAfterRefunds={setNetAfterRefunds}
                vatRate={vatRate}
                hasPayments={payments.length > 0}
              />
            </TabsContent>

            <TabsContent value="patients">
              <PerPatientTab
                patientAnalyses={analysis.patientAnalyses}
                month={month}
                vatRate={vatRate}
                includeRefunds={includeRefunds}
              />
            </TabsContent>

            <TabsContent value="settings">
              <SettingsTab
                vatRate={vatRate}
                setVatRate={setVatRate}
                deductions={deductions}
                setDeductions={setDeductions}
              />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
