import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface AnalysisPayment {
  id: string;
  patient_id: string;
  amount: number;
  paid_at: string | null;
  status: string;
  notes: string | null;
}

export interface AnalysisPatient {
  id: string;
  name: string;
  commission_enabled: boolean;
  commission_type: string;
  commission_value: number | null;
}

export interface GlobalDeduction {
  id: string;
  name: string;
  type: "percent" | "fixed";
  value: number;
  enabled: boolean;
}

export const DEFAULT_DEDUCTIONS: GlobalDeduction[] = [
  { id: "income-tax", name: "מס הכנסה", type: "percent", value: 0, enabled: true },
  { id: "national-insurance", name: "ביטוח לאומי", type: "fixed", value: 0, enabled: true },
];

function getIsraelMonthBounds(month: string): { start: string; end: string } {
  const [year, mon] = month.split("-").map(Number);
  // Israel timezone offset: we create dates in Israel time and convert
  const startLocal = new Date(`${year}-${String(mon).padStart(2, "0")}-01T00:00:00+02:00`);
  const nextMonth = mon === 12 ? 1 : mon + 1;
  const nextYear = mon === 12 ? year + 1 : year;
  const endLocal = new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+02:00`);
  
  return {
    start: startLocal.toISOString(),
    end: endLocal.toISOString(),
  };
}

// Better Israel timezone handling using Intl
function getIsraelMonthBoundsAccurate(month: string): { start: string; end: string } {
  const [year, mon] = month.split("-").map(Number);
  
  // Create date strings and use the timezone-aware approach
  // Israel is UTC+2 in winter, UTC+3 in summer (IDT)
  // We'll use a helper to find the correct offset
  const startDate = new Date(Date.UTC(year, mon - 1, 1));
  const endDate = new Date(Date.UTC(year, mon, 1));
  
  // Get Israel timezone offset for start of month
  const startIsrael = new Date(startDate.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  const startOffset = startIsrael.getTime() - startDate.getTime();
  
  const endIsrael = new Date(endDate.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  const endOffset = endIsrael.getTime() - endDate.getTime();
  
  // Subtract offset to get UTC time that corresponds to midnight Israel time
  const startUTC = new Date(startDate.getTime() - startOffset);
  const endUTC = new Date(endDate.getTime() - endOffset);
  
  return {
    start: startUTC.toISOString(),
    end: endUTC.toISOString(),
  };
}

export function useMonthPayments(month: string) {
  const bounds = getIsraelMonthBoundsAccurate(month);
  const { start, end } = bounds;

  const query = useQuery({
    queryKey: ["analysis-payments", month],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("id, patient_id, amount, paid_at, status, notes")
        .gte("paid_at", start)
        .lt("paid_at", end)
        .order("paid_at", { ascending: true });
      if (error) throw error;
      return (data || []) as AnalysisPayment[];
    },
  });

  return { ...query, debugBounds: bounds };
}

export function useAnalysisPatients() {
  return useQuery({
    queryKey: ["analysis-patients"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("patients")
        .select("id, name, commission_enabled, commission_type, commission_value")
        .order("name");
      if (error) throw error;
      return (data || []) as AnalysisPatient[];
    },
  });
}

export interface PatientAnalysis {
  patient: AnalysisPatient;
  gross: number;
  vat: number;
  base: number;
  commission: number;
  netAfterCommission: number;
  payments: AnalysisPayment[];
  refundCount: number;
  refundAmount: number;
}

export function computeAnalysis(
  payments: AnalysisPayment[],
  patients: AnalysisPatient[],
  vatRate: number,
  deductions: GlobalDeduction[],
  includeRefunds: boolean,
  netAfterRefunds: boolean
) {
  const r = vatRate / 100;

  // Filter payments
  let filtered = payments;
  if (!includeRefunds) {
    filtered = payments.filter((p) => p.status === "paid");
  }

  // Group by patient
  const byPatient = new Map<string, AnalysisPayment[]>();
  for (const p of filtered) {
    const list = byPatient.get(p.patient_id) || [];
    list.push(p);
    byPatient.set(p.patient_id, list);
  }

  // Also count refunds per patient from original payments
  const refundsByPatient = new Map<string, { count: number; amount: number }>();
  for (const p of payments) {
    if (p.status === "refunded" || p.status === "canceled") {
      const curr = refundsByPatient.get(p.patient_id) || { count: 0, amount: 0 };
      curr.count++;
      curr.amount += Math.abs(p.amount);
      refundsByPatient.set(p.patient_id, curr);
    }
  }

  const patientAnalyses: PatientAnalysis[] = [];
  let totalGross = 0;
  let commissionsTotal = 0;
  let totalRefundCount = 0;
  let totalRefundAmount = 0;

  // Process patients that have payments
  const patientMap = new Map(patients.map((p) => [p.id, p]));

  for (const [patientId, patientPayments] of byPatient) {
    const patient = patientMap.get(patientId);
    if (!patient) continue;

    let patientGross = patientPayments.reduce((sum, p) => {
      if (netAfterRefunds && (p.status === "refunded" || p.status === "canceled")) {
        return sum - Math.abs(p.amount);
      }
      return sum + p.amount;
    }, 0);

    const refunds = refundsByPatient.get(patientId) || { count: 0, amount: 0 };
    totalRefundCount += refunds.count;
    totalRefundAmount += refunds.amount;

    const patientVAT = patientGross * r / (1 + r);
    const patientBase = patientGross - patientVAT;

    let commission = 0;
    if (patient.commission_enabled && patient.commission_value != null) {
      if (patient.commission_type === "percent") {
        commission = patientBase * (patient.commission_value / 100);
      } else {
        commission = patient.commission_value;
      }
    }

    totalGross += patientGross;
    commissionsTotal += commission;

    patientAnalyses.push({
      patient,
      gross: patientGross,
      vat: patientVAT,
      base: patientBase,
      commission,
      netAfterCommission: patientBase - commission,
      payments: patientPayments,
      refundCount: refunds.count,
      refundAmount: refunds.amount,
    });
  }

  // Sort by gross descending
  patientAnalyses.sort((a, b) => b.gross - a.gross);

  const totalVAT = totalGross * r / (1 + r);
  const monthBaseAfterVAT = totalGross - totalVAT;

  // Global deductions
  const deductionResults: { name: string; amount: number }[] = [];
  let globalDeductionsTotal = 0;
  for (const d of deductions) {
    if (!d.enabled) continue;
    let amount = 0;
    if (d.type === "percent") {
      amount = monthBaseAfterVAT * (d.value / 100);
    } else {
      amount = d.value;
    }
    deductionResults.push({ name: d.name, amount });
    globalDeductionsTotal += amount;
  }

  const net = monthBaseAfterVAT - globalDeductionsTotal - commissionsTotal;

  return {
    totalGross,
    totalVAT,
    monthBaseAfterVAT,
    deductionResults,
    globalDeductionsTotal,
    commissionsTotal,
    net,
    patientAnalyses,
    paymentCount: filtered.length,
    totalRefundCount,
    totalRefundAmount,
  };
}

export function getStoredDeductions(): GlobalDeduction[] {
  try {
    const stored = localStorage.getItem("analysis-deductions");
    if (stored) return JSON.parse(stored);
  } catch {}
  return DEFAULT_DEDUCTIONS;
}

export function storeDeductions(deductions: GlobalDeduction[]) {
  localStorage.setItem("analysis-deductions", JSON.stringify(deductions));
}

export function getStoredVatRate(): number {
  try {
    const stored = localStorage.getItem("analysis-vat-rate");
    if (stored) return parseFloat(stored);
  } catch {}
  return 17;
}

export function storeVatRate(rate: number) {
  localStorage.setItem("analysis-vat-rate", String(rate));
}
