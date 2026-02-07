import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, LogOut, Users } from "lucide-react";
import GoogleCalendarSection from "@/components/GoogleCalendarSection";
import MonthlyBillingSummary from "@/components/MonthlyBillingSummary";

interface Patient {
  id: string;
  name: string;
  phone: string;
  session_price: number;
  green_invoice_customer_id?: string | null;
  billing_type?: string;
  parent_patient_id?: string | null;
}

const Dashboard = () => {
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPatient, setEditingPatient] = useState<Patient | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [price, setPrice] = useState("");
  const [greenInvoiceId, setGreenInvoiceId] = useState("");
  const [billingType, setBillingType] = useState("monthly");
  const [parentPatientId, setParentPatientId] = useState("");
  const [showPatients, setShowPatients] = useState(false);

  const { data: patients = [], isLoading } = useQuery({
    queryKey: ["patients"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("patients")
        .select("*")
        .order("name");
      if (error) throw error;
      return data as Patient[];
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const oldName = editingPatient?.name;
      if (editingPatient) {
        const { error } = await supabase
          .from("patients")
          .update({ name, phone, session_price: parseFloat(price), green_invoice_customer_id: greenInvoiceId || null, billing_type: billingType, parent_patient_id: parentPatientId || null })
          .eq("id", editingPatient.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("patients")
          .insert({ name, phone, session_price: parseFloat(price), therapist_id: user!.id, green_invoice_customer_id: greenInvoiceId || null, billing_type: billingType, parent_patient_id: parentPatientId || null });
        if (error) throw error;
      }

      // If name changed, update calendar events in the background (don't block save)
      if (editingPatient && oldName && oldName !== name) {
        supabase.auth.getSession().then(({ data: { session } }) => {
          if (!session) return;
          const renameInBackground = async () => {
            try {
              await supabase.functions.invoke("google-calendar-rename-events", {
                headers: { Authorization: `Bearer ${session.access_token}` },
                body: { oldName, newName: name },
              });

              const { data: aliases } = await supabase
                .from("event_aliases")
                .select("event_name")
                .eq("patient_id", editingPatient.id);

              if (aliases) {
                for (const alias of aliases) {
                  if (alias.event_name !== oldName) {
                    await supabase.functions.invoke("google-calendar-rename-events", {
                      headers: { Authorization: `Bearer ${session.access_token}` },
                      body: { oldName: alias.event_name, newName: name },
                    });
                  }
                }
              }
            } catch (e) {
              console.error("Failed to update calendar names:", e);
            }
          };
          renameInBackground();
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["patients"] });
      queryClient.invalidateQueries({ queryKey: ["google-calendar-events-billing"] });
      resetForm();
      toast({ title: editingPatient ? "המטופל עודכן והיומן עודכן" : "מטופל נוסף בהצלחה" });
    },
    onError: (error: any) => {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("patients").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["patients"] });
      toast({ title: "המטופל נמחק" });
    },
  });

  const resetForm = () => {
    setName("");
    setPhone("");
    setPrice("");
    setGreenInvoiceId("");
    setBillingType("monthly");
    setParentPatientId("");
    setEditingPatient(null);
    setDialogOpen(false);
  };

  const openEdit = (patient: Patient) => {
    setEditingPatient(patient);
    setName(patient.name);
    setPhone(patient.phone);
    setPrice(patient.session_price.toString());
    setGreenInvoiceId(patient.green_invoice_customer_id || "");
    setBillingType(patient.billing_type || "monthly");
    setParentPatientId(patient.parent_patient_id || "");
    setDialogOpen(true);
  };

  return (
    <div className="min-h-screen bg-background p-4 md:p-8" dir="rtl">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-3xl font-bold text-foreground">💬 סיכום חיוב חודשי</h1>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowPatients(!showPatients)}>
              <Users className="ml-2 h-4 w-4" />
              ניהול מטופלים
            </Button>
            <Button variant="outline" onClick={signOut}>
              <LogOut className="ml-2 h-4 w-4" />
              התנתק
            </Button>
          </div>
        </div>

        {/* Google Calendar connection (only shows if not connected) */}
        <div className="mb-6">
          <GoogleCalendarSection />
        </div>

        {/* Monthly billing summary - the main view */}
        <div className="mb-6">
          <MonthlyBillingSummary patients={patients} />
        </div>

        {/* Patient management - collapsible */}
        {showPatients && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">ניהול מטופלים</h2>
              <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) resetForm(); setDialogOpen(open); }}>
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="ml-2 h-4 w-4" />
                    הוסף מטופל
                  </Button>
                </DialogTrigger>
                <DialogContent dir="rtl">
                  <DialogHeader>
                    <DialogTitle>{editingPatient ? "עריכת מטופל" : "הוספת מטופל חדש"}</DialogTitle>
                  </DialogHeader>
                  <form
                    onSubmit={(e) => { e.preventDefault(); saveMutation.mutate(); }}
                    className="space-y-4"
                  >
                    <div className="space-y-2">
                      <Label>שם</Label>
                      <Input value={name} onChange={(e) => setName(e.target.value)} required />
                    </div>
                    <div className="space-y-2">
                      <Label>טלפון</Label>
                      <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050-1234567" required dir="ltr" />
                    </div>
                    <div className="space-y-2">
                      <Label>מחיר לטיפול (₪)</Label>
                      <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} required dir="ltr" />
                    </div>
                    <div className="space-y-2">
                      <Label>סוג חיוב</Label>
                      <select
                        value={billingType}
                        onChange={(e) => setBillingType(e.target.value)}
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        <option value="monthly">חודשי (ברירת מחדל)</option>
                        <option value="per_session">לפגישה</option>
                        <option value="institution">מוסד</option>
                      </select>
                    </div>
                    {billingType !== "institution" && (
                      <div className="space-y-2">
                        <Label>שייך למוסד (אופציונלי)</Label>
                        <select
                          value={parentPatientId}
                          onChange={(e) => setParentPatientId(e.target.value)}
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          <option value="">ללא</option>
                          {patients.filter(p => (p as any).billing_type === "institution" && p.id !== editingPatient?.id).map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label>מזהה לקוח בחשבונית ירוקה (אופציונלי)</Label>
                      <Input value={greenInvoiceId} onChange={(e) => setGreenInvoiceId(e.target.value)} placeholder="מזהה לקוח מחשבונית ירוקה" dir="ltr" />
                    </div>
                    <Button type="submit" className="w-full" disabled={saveMutation.isPending}>
                      {saveMutation.isPending ? "שומר..." : "שמור"}
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>
            </div>

            {isLoading ? (
              <p className="text-muted-foreground">טוען...</p>
            ) : patients.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center">
                  <p className="text-muted-foreground">אין מטופלים. הוסף את המטופל הראשון!</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {patients.map((patient) => (
                  <div key={patient.id} className="flex items-center justify-between rounded-lg border p-3 bg-card">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{patient.name}</span>
                      {(patient as any).billing_type === "institution" && (
                        <span className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 px-2 py-0.5 rounded-full">מוסד</span>
                      )}
                      {(patient as any).billing_type === "per_session" && (
                        <span className="text-xs bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 px-2 py-0.5 rounded-full">לפגישה</span>
                      )}
                      {(patient as any).parent_patient_id && (
                        <span className="text-xs bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-300 px-2 py-0.5 rounded-full">
                          ← {patients.find(p => p.id === (patient as any).parent_patient_id)?.name || "מוסד"}
                        </span>
                      )}
                      <span className="text-sm text-muted-foreground" dir="ltr">{patient.phone}</span>
                      <span className="text-sm text-muted-foreground">₪{patient.session_price}</span>
                    </div>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" onClick={() => openEdit(patient)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => deleteMutation.mutate(patient.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
