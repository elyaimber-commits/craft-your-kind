import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, FileText, ExternalLink } from "lucide-react";

interface SessionItem {
  date: string;
  summary: string;
  eventId?: string;
  sessionPrice?: number;
  isPaidPending?: boolean; // orange = שולם, ממתין לחשבונית
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patient: { id: string; name: string; session_price: number };
  sessions: SessionItem[]; // current month sessions
}

type DocType = 320 | 305 | 400;
type Mode = "sessions" | "custom";

const DOC_LABELS: Record<DocType, string> = {
  320: "חשבונית מס/קבלה",
  305: "חשבונית מס",
  400: "קבלה",
};

const GreenInvoiceCreateDialog = ({ open, onOpenChange, patient, sessions }: Props) => {
  const { toast } = useToast();
  const [docType, setDocType] = useState<DocType>(320);
  const [mode, setMode] = useState<Mode>("sessions");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [customAmount, setCustomAmount] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    documentNumber?: string;
    documentUrl?: string;
    sentByEmail: boolean;
    recipientEmail?: string | null;
  } | null>(null);

  // Pre-select orange (paid pending invoice) sessions when opening
  useEffect(() => {
    if (open) {
      const preselect = new Set(
        sessions.filter((s) => s.isPaidPending && s.eventId).map((s) => s.eventId!)
      );
      setSelectedIds(preselect);
      setMode("sessions");
      setResult(null);
      setCustomAmount("");
      setCustomDescription("");
    }
  }, [open, sessions]);

  const toggleSession = (eventId: string) => {
    const next = new Set(selectedIds);
    if (next.has(eventId)) next.delete(eventId);
    else next.add(eventId);
    setSelectedIds(next);
  };

  const selectedSessions = sessions.filter((s) => s.eventId && selectedIds.has(s.eventId));
  const sessionsTotal = selectedSessions.reduce(
    (sum, s) => sum + (s.sessionPrice ?? patient.session_price),
    0
  );

  const customTotal = parseFloat(customAmount) || 0;
  const totalAmount = mode === "sessions" ? sessionsTotal : customTotal;

  const canSubmit =
    !submitting &&
    (mode === "sessions"
      ? selectedSessions.length > 0
      : customTotal > 0 && customDescription.trim().length > 0);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const body: any = {
        patientId: patient.id,
        documentType: docType,
      };

      if (mode === "sessions") {
        body.sessions = selectedSessions.map((s) => ({
          date: s.date,
          price: s.sessionPrice ?? patient.session_price,
          description: `פגישה ${s.date}`,
        }));
      } else {
        body.customAmount = customTotal;
        body.customDescription = customDescription.trim();
      }

      const res = await supabase.functions.invoke("green-invoice-create", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body,
      });

      if (res.error) {
        const errMsg = (res.error as any)?.message || "שגיאה ביצירת חשבונית";
        // Try to read response body for details
        let details = "";
        try {
          const ctx = (res.error as any).context;
          if (ctx?.body) {
            const parsed = typeof ctx.body === "string" ? JSON.parse(ctx.body) : ctx.body;
            details = parsed.error || JSON.stringify(parsed);
          }
        } catch {}
        throw new Error(details || errMsg);
      }

      const data = res.data as any;
      if (!data?.success) {
        throw new Error(data?.error || "יצירת חשבונית נכשלה");
      }

      setResult({
        documentNumber: data.documentNumber,
        documentUrl: data.documentUrl,
        sentByEmail: data.sentByEmail,
        recipientEmail: data.recipientEmail,
      });

      toast({
        title: `${DOC_LABELS[docType]} #${data.documentNumber} הופקה ✓`,
        description: data.sentByEmail
          ? `נשלחה במייל ל-${data.recipientEmail}`
          : "לא נשלחה במייל (אין כתובת ב-Green Invoice)",
      });
    } catch (e: any) {
      toast({
        title: "שגיאה",
        description: e.message || "יצירת החשבונית נכשלה",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            הפק חשבונית — {patient.name}
          </DialogTitle>
          <DialogDescription>
            מתחבר ל-Green Invoice ויוצר את המסמך. אם יש למטופל כתובת מייל ב-Green Invoice — הוא יישלח אליו אוטומטית.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 py-4">
            <div className="rounded-lg border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 p-4 space-y-2">
              <p className="font-semibold text-green-700 dark:text-green-400">
                ✓ {DOC_LABELS[docType]} #{result.documentNumber} הופקה בהצלחה
              </p>
              {result.sentByEmail ? (
                <p className="text-sm">נשלחה במייל ל: <strong>{result.recipientEmail}</strong></p>
              ) : (
                <p className="text-sm text-muted-foreground">לא נשלחה במייל — לא נמצאה כתובת מייל ב-Green Invoice עבור הלקוח.</p>
              )}
              {result.documentUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(result.documentUrl, "_blank")}
                  className="gap-1"
                >
                  <ExternalLink className="h-3 w-3" />
                  פתח את המסמך
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              סטטוס התשלום במערכת יתעדכן אוטומטית תוך מספר שניות דרך ה-webhook של Green Invoice.
            </p>
          </div>
        ) : (
          <div className="space-y-5 py-2">
            {/* Document type */}
            <div className="space-y-2">
              <Label>סוג מסמך</Label>
              <RadioGroup
                value={String(docType)}
                onValueChange={(v) => setDocType(Number(v) as DocType)}
                className="flex flex-wrap gap-4"
              >
                {([320, 305, 400] as DocType[]).map((t) => (
                  <div key={t} className="flex items-center gap-2">
                    <RadioGroupItem value={String(t)} id={`doc-${t}`} />
                    <Label htmlFor={`doc-${t}`} className="cursor-pointer font-normal">
                      {DOC_LABELS[t]} ({t})
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>

            {/* Mode toggle */}
            <div className="space-y-2">
              <Label>תוכן החשבונית</Label>
              <RadioGroup
                value={mode}
                onValueChange={(v) => setMode(v as Mode)}
                className="flex flex-wrap gap-4"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="sessions" id="mode-sessions" />
                  <Label htmlFor="mode-sessions" className="cursor-pointer font-normal">
                    בחירת פגישות מהחודש
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="custom" id="mode-custom" />
                  <Label htmlFor="mode-custom" className="cursor-pointer font-normal">
                    סכום מותאם (דרישת תשלום ידנית)
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {/* Sessions picker */}
            {mode === "sessions" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>פגישות לכלול</Label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setSelectedIds(new Set(sessions.filter(s => s.eventId).map(s => s.eventId!)))}
                    >
                      בחר הכל
                    </button>
                    <span className="text-xs text-muted-foreground">|</span>
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setSelectedIds(new Set())}
                    >
                      נקה
                    </button>
                  </div>
                </div>
                <div className="rounded-lg border max-h-64 overflow-y-auto divide-y">
                  {sessions.length === 0 ? (
                    <p className="p-4 text-center text-sm text-muted-foreground">אין פגישות החודש</p>
                  ) : (
                    sessions.map((s, i) => {
                      const checked = s.eventId ? selectedIds.has(s.eventId) : false;
                      return (
                        <label
                          key={s.eventId || i}
                          className="flex items-center justify-between p-2 cursor-pointer hover:bg-accent/30"
                        >
                          <div className="flex items-center gap-2">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => s.eventId && toggleSession(s.eventId)}
                              disabled={!s.eventId}
                            />
                            <span className="text-sm" dir="ltr">{s.date}</span>
                            {s.isPaidPending && (
                              <span className="text-xs bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 px-1.5 py-0.5 rounded">
                                שולם, ממתין
                              </span>
                            )}
                          </div>
                          <span className="text-sm font-mono">₪{s.sessionPrice ?? patient.session_price}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {/* Custom amount */}
            {mode === "custom" && (
              <div className="space-y-3">
                <div>
                  <Label htmlFor="custom-desc">תיאור</Label>
                  <Input
                    id="custom-desc"
                    placeholder="לדוגמא: דרישת תשלום עבור פגישות מאי"
                    value={customDescription}
                    onChange={(e) => setCustomDescription(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="custom-amount">סכום (₪)</Label>
                  <Input
                    id="custom-amount"
                    type="number"
                    placeholder="0"
                    value={customAmount}
                    onChange={(e) => setCustomAmount(e.target.value)}
                    dir="ltr"
                  />
                </div>
              </div>
            )}

            {/* Total */}
            <div className="rounded-lg bg-accent/50 p-3 flex items-center justify-between">
              <span className="font-medium">סה״כ לחשבונית</span>
              <span className="font-bold text-lg">₪{totalAmount}</span>
            </div>
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>סגור</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                ביטול
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {submitting && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
                הפק {DOC_LABELS[docType]}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default GreenInvoiceCreateDialog;
