import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Copy, CheckCircle2, AlertCircle, Receipt } from "lucide-react";

const WEBHOOK_URL = "https://puejfjhrinmsjvisyomh.supabase.co/functions/v1/green-invoice-webhook";

const GreenInvoiceWebhookCard = () => {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const { data: stats } = useQuery({
    queryKey: ["green-invoice-stats"],
    queryFn: async () => {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const { count: webhookCount } = await supabase
        .from("payments")
        .select("*", { count: "exact", head: true })
        .eq("external_source", "green_invoice")
        .gte("created_at", thirtyDaysAgo.toISOString());

      const { data: missingIds } = await supabase
        .from("patients")
        .select("id, name")
        .is("green_invoice_customer_id", null)
        .order("name");

      const { data: lastPayment } = await supabase
        .from("payments")
        .select("created_at, receipt_number")
        .eq("external_source", "green_invoice")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      return {
        webhookCount: webhookCount || 0,
        missingIds: missingIds || [],
        lastPayment,
      };
    },
  });

  const copyUrl = async () => {
    await navigator.clipboard.writeText(WEBHOOK_URL);
    setCopied(true);
    toast({ title: "הועתק", description: "ה-URL הועתק ללוח" });
    setTimeout(() => setCopied(false), 2000);
  };

  const isWorking = (stats?.webhookCount ?? 0) > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Receipt className="h-5 w-5" />
          אינטגרציית גרין-אינבויס
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Connection status */}
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <div className="text-sm font-medium">סטטוס חיבור</div>
            <div className="text-xs text-muted-foreground mt-1">
              {isWorking
                ? `${stats?.webhookCount} חשבוניות התקבלו ב-30 הימים האחרונים`
                : "לא התקבלו חשבוניות ב-30 הימים האחרונים"}
            </div>
            {stats?.lastPayment && (
              <div className="text-xs text-muted-foreground">
                אחרונה: #{stats.lastPayment.receipt_number} ב-
                {new Date(stats.lastPayment.created_at).toLocaleDateString("he-IL")}
              </div>
            )}
          </div>
          {isWorking ? (
            <Badge variant="default" className="bg-green-600 hover:bg-green-700">
              <CheckCircle2 className="ml-1 h-3 w-3" />
              פעיל
            </Badge>
          ) : (
            <Badge variant="destructive">
              <AlertCircle className="ml-1 h-3 w-3" />
              לא פעיל
            </Badge>
          )}
        </div>

        {/* Webhook URL */}
        <div>
          <div className="text-sm font-medium mb-2">כתובת ה-Webhook להגדרה בגרין-אינבויס</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md bg-muted px-3 py-2 text-xs break-all" dir="ltr">
              {WEBHOOK_URL}
            </code>
            <Button size="sm" variant="outline" onClick={copyUrl}>
              {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <div className="text-xs text-muted-foreground mt-2">
            Event type: <code>document/created</code> · Secret: ריק
          </div>
        </div>

        {/* No webhook warning */}
        {!isWorking && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              נראה שגרין-אינבויס לא שולח התראות. בדוק בפאנל גרין-אינבויס:
              <ol className="list-decimal mr-4 mt-1 space-y-1">
                <li>שה-URL למעלה זהה למה שמוגדר</li>
                <li>ש-Event type הוא <code>document/created</code></li>
                <li>שהוובהוק במצב "פעיל"</li>
              </ol>
            </AlertDescription>
          </Alert>
        )}

        {/* Missing IDs warning */}
        {stats && stats.missingIds.length > 0 && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>{stats.missingIds.length} מטופלים</strong> ללא Green Invoice ID — חשבוניות עבורם לא יסונכרנו אוטומטית:
              <div className="mt-1 text-muted-foreground">
                {stats.missingIds.slice(0, 8).map((p) => p.name).join(" · ")}
                {stats.missingIds.length > 8 && ` · ועוד ${stats.missingIds.length - 8}`}
              </div>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};

export default GreenInvoiceWebhookCard;
