import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Copy, CheckCircle2, AlertCircle, Receipt, ScrollText, Clock, Check, Loader2, X } from "lucide-react";

const WEBHOOK_URL = "https://puejfjhrinmsjvisyomh.supabase.co/functions/v1/green-invoice-webhook";

const formatDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
};

const MissingIdRow = ({ patient, onSaved }: { patient: { id: string; name: string }; onSaved: () => void }) => {
  const { toast } = useToast();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [hiding, setHiding] = useState(false);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      toast({ title: "יש להזין מזהה", variant: "destructive" });
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("patients")
      .update({ green_invoice_customer_id: trimmed })
      .eq("id", patient.id);
    setSaving(false);
    if (error) {
      toast({ title: "שגיאה בשמירה", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "נשמר", description: `${patient.name} עודכן בהצלחה` });
    setValue("");
    onSaved();
  };

  const hide = async () => {
    if (!confirm(`להסיר את ${patient.name} מהרשימה? (לא יסונכרן עם גרין-אינבויס)`)) return;
    setHiding(true);
    const { error } = await supabase
      .from("patients")
      .update({ skip_green_invoice: true })
      .eq("id", patient.id);
    setHiding(false);
    if (error) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "הוסר מהרשימה", description: patient.name });
    onSaved();
  };

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <span className="flex-1 text-xs truncate">{patient.name}</span>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); }}
        placeholder="Green Invoice ID"
        className="h-7 text-xs w-40"
        dir="ltr"
        disabled={saving || hiding}
      />
      <Button size="sm" variant="outline" className="h-7 px-2" onClick={save} disabled={saving || hiding} title="שמור מזהה">
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-muted-foreground hover:text-destructive"
        onClick={hide}
        disabled={saving || hiding}
        title="הסר מהרשימה"
      >
        {hiding ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
      </Button>
    </li>
  );
};

const GreenInvoiceWebhookCard = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [showOnlyFailed, setShowOnlyFailed] = useState(false);

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
        .eq("skip_green_invoice", false)
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
                  <>
                    ,{" "}
                    <button
                      type="button"
                      onClick={() => { setShowOnlyFailed(true); setLogsOpen(true); refetchLogs(); }}
                      className="text-destructive underline hover:no-underline font-medium"
                    >
                      {stats.failed24h} נכשלו - הצג פירוט
                    </button>
                  </>
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
        <Dialog open={logsOpen} onOpenChange={(o) => { setLogsOpen(o); if (o) refetchLogs(); else setShowOnlyFailed(false); }}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="w-full" onClick={() => setShowOnlyFailed(false)}>
              <ScrollText className="ml-2 h-4 w-4" />
              הצג יומן Webhook (20 אחרונים)
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {showOnlyFailed ? "כשלונות Webhook (24 שעות)" : "יומן קריאות Webhook מגרין-אינבויס"}
              </DialogTitle>
            </DialogHeader>
            <div className="flex items-center gap-2 pb-2">
              <Button
                size="sm"
                variant={showOnlyFailed ? "default" : "outline"}
                onClick={() => setShowOnlyFailed(true)}
              >
                רק כשלונות
              </Button>
              <Button
                size="sm"
                variant={!showOnlyFailed ? "default" : "outline"}
                onClick={() => setShowOnlyFailed(false)}
              >
                הכל
              </Button>
            </div>
            <div className="space-y-2">
              {(() => {
                const filtered = (logs || []).filter((l: any) => !showOnlyFailed || l.error);
                if (filtered.length === 0) {
                  return (
                    <div className="text-sm text-muted-foreground text-center py-8">
                      {showOnlyFailed ? "אין כשלונות 🎉" : "עדיין לא התקבלו קריאות מגרין-אינבויס."}
                    </div>
                  );
                }
                return filtered.map((log: any) => (
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
                      <div className="text-destructive font-medium">שגיאה: {log.error}</div>
                    )}
                    {log.payload && (
                      <details className="mt-1" open={!!log.error}>
                        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                          הצג Payload
                        </summary>
                        <pre className="mt-1 overflow-auto rounded bg-muted p-2 text-[10px]" dir="ltr">
                          {JSON.stringify(log.payload, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                ));
              })()}
            </div>
          </DialogContent>
        </Dialog>
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

        {/* Missing IDs section */}
        {stats && stats.missingIds.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              <div className="text-sm font-medium">
                מטופלים ללא Green Invoice ID ({stats.missingIds.length})
              </div>
            </div>
            <div className="text-xs text-muted-foreground mb-2">
              חשבוניות עבור המטופלים הבאים לא יסונכרנו אוטומטית:
            </div>
            <div className="max-h-72 overflow-y-auto rounded bg-background/50 border">
              <ul className="divide-y">
                {stats.missingIds.map((p) => (
                  <MissingIdRow
                    key={p.id}
                    patient={p}
                    onSaved={() => {
                      queryClient.invalidateQueries({ queryKey: ["green-invoice-stats-v2"] });
                    }}
                  />
                ))}
              </ul>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default GreenInvoiceWebhookCard;
