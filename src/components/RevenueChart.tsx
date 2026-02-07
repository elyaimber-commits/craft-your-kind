import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { TrendingUp } from "lucide-react";

const RevenueChart = () => {
  const { user } = useAuth();

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ["payments-all-months"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("month, amount, paid_event_ids")
        .order("month", { ascending: true });
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  // Aggregate by month
  const monthlyData = payments.reduce<Record<string, { total: number; paid: number }>>((acc, p) => {
    if (!acc[p.month]) acc[p.month] = { total: 0, paid: 0 };
    acc[p.month].total += Number(p.amount);
    const paidIds = p.paid_event_ids || [];
    if (paidIds.length > 0) acc[p.month].paid += Number(p.amount);
    return acc;
  }, {});

  const chartData = Object.entries(monthlyData)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([month, data]) => {
      const [y, m] = month.split("-");
      const label = new Date(parseInt(y), parseInt(m) - 1).toLocaleDateString("he-IL", { month: "short" });
      return { month: label, total: data.total, paid: data.paid };
    });

  if (isLoading || chartData.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <TrendingUp className="h-5 w-5" />
          הכנסות חודשיות
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[250px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey="month" fontSize={12} />
              <YAxis fontSize={12} tickFormatter={(v) => `₪${v}`} />
              <Tooltip
                formatter={(value: number) => [`₪${value}`, ""]}
                labelFormatter={(label) => label}
              />
              <Bar dataKey="total" name="סה״כ" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              <Bar dataKey="paid" name="שולם" fill="hsl(142, 71%, 45%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
};

export default RevenueChart;
