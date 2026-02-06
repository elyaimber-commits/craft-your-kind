import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { UserPlus } from "lucide-react";

interface NewPatientSuggestionProps {
  name: string;
  sessionCount: number;
}

const NewPatientSuggestion = ({ name, sessionCount }: NewPatientSuggestionProps) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [phone, setPhone] = useState("");
  const [price, setPrice] = useState("");

  const addMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("patients").insert({
        name,
        phone,
        session_price: parseFloat(price),
        therapist_id: user!.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["patients"] });
      toast({ title: `${name} נוסף כמטופל!` });
      setShowForm(false);
    },
    onError: (error: any) => {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    },
  });

  if (!showForm) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
        <div>
          <span className="font-medium">{name}</span>
          <span className="text-sm text-muted-foreground mr-2">
            ({sessionCount} פגישות צהובות ביומן)
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
          <UserPlus className="ml-1 h-4 w-4" />
          הוסף כמטופל
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 space-y-3">
      <div className="font-medium">{name}</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          addMutation.mutate();
        }}
        className="flex items-end gap-2"
      >
        <div className="flex-1">
          <label className="text-xs text-muted-foreground">טלפון</label>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="050-1234567"
            required
            dir="ltr"
            className="h-8"
          />
        </div>
        <div className="flex-1">
          <label className="text-xs text-muted-foreground">מחיר לטיפול (₪)</label>
          <Input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
            dir="ltr"
            className="h-8"
          />
        </div>
        <Button size="sm" type="submit" disabled={addMutation.isPending}>
          {addMutation.isPending ? "שומר..." : "שמור"}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setShowForm(false)}>
          ביטול
        </Button>
      </form>
    </div>
  );
};

export default NewPatientSuggestion;
