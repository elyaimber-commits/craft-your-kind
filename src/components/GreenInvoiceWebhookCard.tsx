import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Copy, CheckCircle2, AlertCircle, Receipt, ScrollText, Clock } from "lucide-react";

const WEBHOOK_URL = "https://puejfjhrinmsjvisyomh.supabase.co/functions/v1/green-invoice-webhook";

const formatDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
};

const GreenInvoiceWebhookCard = () => {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  const { data: stats } = useQuery({
    queryKey: ["green-invoice-stats-v2"],
    queryFn: async () => {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);

      // Recent webhook logs (any call from Morning)
      const { count: recentLogsCount } = await supabase
        .from("webhook_logs")
        .select("*", { count: "exact", head: true })
        .eq("source", "green_invoice")
        .gte("received_at", sevenDaysAgo.toISOString());

      // Failed/error logs in last 24h
      const { count: failed24h } = await supabase
        .from("webhook_logs")
        .select("*", { count: "exact", head: true })
        .eq("source", "green_invoice")
        .gte("received_at", oneDayAgo.toISOString())
        .not("error", "is", null);

      // Successful (no error) logs in last 24h
      const { count: success24h } = await supabase
        .from("webhook_logs")
        .select("*", { count: "exact", head: true })
        .eq("source", "green_invoice")
        .gte("received_at", oneDayAgo.toISOString())
        .is("error", null);

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

      const { data: lastLog } = await supabase
        .from("webhook_logs")
        .select("received_at, status_code, error")
        .eq("source", "green_invoice")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      return {
        recentLogsCount: recentLogsCount || 0,
        failed24h: failed24h || 0,
        success24h: success24h || 0,
        missingIds: missingIds || [],
        lastPayment,
        lastLog,
      };
    },
  });

  const { data: logs, refetch: refetchLogs } = useQuery({
    queryKey: ["webhook-logs"],
    queryFn: async () => {
      const { data } = await supabase
        .from("webhook_logs")
        .select("*")
        .eq("source", "green_invoice")
        .order("received_at", { ascending: false })
        .limit(20);
      return data || [];
    },
    enabled: logsOpen,
  });

  const copyUrl = async () => {
    await navigator.clipboard.writeText(WEBHOOK_URL);
    setCopied(true);
    toast({ title: "הועתק", description: "ה-URL הועתק ללוח" });
    setTimeout(() => setCopied(false), 2000);
  };

  const isWorking = (stats?.recentLogsCount ?? 0) > 0;

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
          <div className="flex-1">
            <div className="text-sm font-medium">סטטוס חיבור</div>
            <div className="text-xs text-muted-foreground mt-1">
              {isWorking
                ? `${stats?.recentLogsCount} קריאות ב-7 הימים האחרונים`
                : "לא התקבלו קריאות מגרין-אינבויס ב-7 הימים האחרונים"}
            </div>
            {stats && (stats.success24h > 0 || stats.failed24h > 0) && (
              <div className="text-xs text-muted-foreground mt-0.5">
                ב-24 שעות: {stats.success24h} הצליחו
                {stats.failed24h > 0 && (
                  <span className="text-destructive">, {stats.failed24h} נכשלו</span>
                )}
              </div>
            )}
            {stats?.lastLog && (
              <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <Clock className="h-3 w-3" />
                אחרון: {formatDate(stats.lastLog.received_at)}
                {stats.lastLog.error && (
                  <span className="text-destructive"> · שגיאה</span>
                )}
              </div>
            )}
            {stats?.lastPayment && (
              <div className="text-xs text-muted-foreground">
                תשלום אחרון: #{stats.lastPayment.receipt_number} ב-
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
            <Badge variant="secondary">
              <Clock className="ml-1 h-3 w-3" />
              ממתין לקריאה
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
            Event type: <code>document/created</code>
          </div>
        </div>

        {/* Logs button */}
        <Dialog open={logsOpen} onOpenChange={(o) => { setLogsOpen(o); if (o) refetchLogs(); }}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="w-full">
              <ScrollText className="ml-2 h-4 w-4" />
              הצג יומן Webhook (20 אחרונים)
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>יומן קריאות Webhook מגרין-אינבויס</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              {!logs || logs.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">
                  עדיין לא התקבלו קריאות מגרין-אינבויס.
                </div>
              ) : (
                logs.map((log: any) => (
                  <div
                    key={log.id}
                    className={`rounded-md border p-3 text-xs space-y-1 ${
                      log.error ? "border-destructive/50 bg-destructive/5" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium">{formatDate(log.received_at)}</div>
                      <Badge variant={log.error ? "destructive" : "default"} className="text-xs">
                        {log.status_code} {log.event_type ? `· ${log.event_type}` : ""}
                      </Badge>
                    </div>
                    {log.external_payment_id && (
                      <div className="text-muted-foreground">
                        מזהה מסמך: {log.external_payment_id}
                      </div>
                    )}
                    {log.error && (
                      <div className="text-destructive">שגיאה: {log.error}</div>
                    )}
                    {log.payload && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                          הצג Payload
                        </summary>
                        <pre className="mt-1 overflow-auto rounded bg-muted p-2 text-[10px]" dir="ltr">
                          {JSON.stringify(log.payload, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                ))
              )}
            </div>
          </DialogContent>
        </Dialog>

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
