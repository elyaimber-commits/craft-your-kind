import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight, Search, History } from "lucide-react";
import { useNavigate } from "react-router-dom";

const PaymentHistory = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ["all-payments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("*, patients(name, phone)")
        .order("month", { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  const filtered = searchQuery.trim()
    ? payments.filter((p: any) =>
        p.patients?.name?.includes(searchQuery.trim()) ||
        p.month.includes(searchQuery.trim())
      )
    : payments;

  // Group by month
  const grouped = filtered.reduce<Record<string, any[]>>((acc, p) => {
    if (!acc[p.month]) acc[p.month] = [];
    acc[p.month].push(p);
    return acc;
  }, {});

  const monthLabel = (month: string) => {
    const [y, m] = month.split("-");
    return new Date(parseInt(y), parseInt(m) - 1).toLocaleDateString("he-IL", {
      month: "long",
      year: "numeric",
    });
  };

  return (
    <div className="min-h-screen bg-background p-4 md:p-8" dir="rtl">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <History className="h-6 w-6" />
            היסטוריית תשלומים
          </h1>
          <Button variant="outline" onClick={() => navigate("/dashboard")}>
            <ArrowRight className="ml-2 h-4 w-4" />
            חזרה
          </Button>
        </div>

        <div className="relative mb-4">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="חיפוש לפי שם מטופל או חודש..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pr-9"
          />
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-center py-8">טוען...</p>
        ) : Object.keys(grouped).length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              אין תשלומים להצגה
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {Object.entries(grouped).map(([month, monthPayments]) => {
              const totalMonth = monthPayments.reduce((s: number, p: any) => s + Number(p.amount), 0);
              return (
                <Card key={month}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-base">
                      <span>{monthLabel(month)}</span>
                      <span className="text-sm font-normal text-muted-foreground">
                        סה״כ: ₪{totalMonth}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1">
                      {monthPayments.map((p: any) => (
                        <div
                          key={p.id}
                          className="flex items-center justify-between py-2 px-2 rounded text-sm hover:bg-accent/50 transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{p.patients?.name || "—"}</span>
                            <span className="text-muted-foreground">
                              {p.session_count} פגישות
                            </span>
                            {p.paid && (
                              <span className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-2 py-0.5 rounded-full">
                                שולם
                              </span>
                            )}
                            {!p.paid && (p.paid_event_ids?.length || 0) > 0 && (
                              <span className="text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 px-2 py-0.5 rounded-full">
                                חלקי
                              </span>
                            )}
                          </div>
                          <span className="font-medium">₪{p.amount}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default PaymentHistory;
