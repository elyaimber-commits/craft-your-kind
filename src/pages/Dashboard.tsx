import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, MessageCircle, Pencil, Trash2, LogOut } from "lucide-react";

interface Patient {
  id: string;
  name: string;
  phone: string;
  session_price: number;
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
      if (editingPatient) {
        const { error } = await supabase
          .from("patients")
          .update({ name, phone, session_price: parseFloat(price) })
          .eq("id", editingPatient.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("patients")
          .insert({ name, phone, session_price: parseFloat(price), therapist_id: user!.id });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["patients"] });
      resetForm();
      toast({ title: editingPatient ? "המטופל עודכן" : "מטופל נוסף בהצלחה" });
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
    setEditingPatient(null);
    setDialogOpen(false);
  };

  const openEdit = (patient: Patient) => {
    setEditingPatient(patient);
    setName(patient.name);
    setPhone(patient.phone);
    setPrice(patient.session_price.toString());
    setDialogOpen(true);
  };

  const generateWhatsAppLink = (patient: Patient) => {
    const message = encodeURIComponent(
      `שלום ${patient.name}, זוהי בקשת תשלום עבור הטיפול.\nסכום: ₪${patient.session_price}\nתודה! 🙏`
    );
    const cleanPhone = patient.phone.replace(/\D/g, "");
    const intlPhone = cleanPhone.startsWith("0") ? "972" + cleanPhone.slice(1) : cleanPhone;
    return `https://wa.me/${intlPhone}?text=${message}`;
  };

  const sendWhatsApp = (patient: Patient) => {
    window.open(generateWhatsAppLink(patient), "_blank");
  };

  return (
    <div className="min-h-screen bg-background p-4 md:p-8" dir="rtl">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-3xl font-bold text-foreground">💬 ניהול מטופלים</h1>
          <Button variant="outline" onClick={signOut}>
            <LogOut className="ml-2 h-4 w-4" />
            התנתק
          </Button>
        </div>

        <div className="mb-6">
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
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">אין מטופלים עדיין. הוסף את המטופל הראשון!</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">שם</TableHead>
                    <TableHead className="text-right">טלפון</TableHead>
                    <TableHead className="text-right">מחיר (₪)</TableHead>
                    <TableHead className="text-right">פעולות</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {patients.map((patient) => (
                    <TableRow key={patient.id}>
                      <TableCell className="font-medium">{patient.name}</TableCell>
                      <TableCell dir="ltr" className="text-right">{patient.phone}</TableCell>
                      <TableCell>{patient.session_price}</TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button size="sm" variant="default" onClick={() => sendWhatsApp(patient)}>
                            <MessageCircle className="ml-1 h-4 w-4" />
                            וואטסאפ
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => openEdit(patient)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => deleteMutation.mutate(patient.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
