import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Link2, UserPlus, ChevronDown, ChevronUp } from "lucide-react";

interface Patient {
  id: string;
  name: string;
  phone: string;
  session_price: number;
}

interface EventAliasSuggestionProps {
  eventName: string;
  sessionCount: number;
  suggestedPatients: Patient[];
  allPatients: Patient[];
}

const EventAliasSuggestion = ({
  eventName,
  sessionCount,
  suggestedPatients,
  allPatients,
}: EventAliasSuggestionProps) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showAllPatients, setShowAllPatients] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [phone, setPhone] = useState("");
  const [price, setPrice] = useState("");

  const linkMutation = useMutation({
    mutationFn: async (patientId: string) => {
      const { error } = await supabase.from("event_aliases").insert({
        therapist_id: user!.id,
        event_name: eventName,
        patient_id: patientId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event-aliases"] });
      queryClient.invalidateQueries({ queryKey: ["google-calendar-events-billing"] });
      toast({ title: `"${eventName}" שויך בהצלחה!` });
    },
    onError: (error: any) => {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    },
  });

  const addPatientMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("patients").insert({
        name: eventName,
        phone,
        session_price: parseFloat(price),
        therapist_id: user!.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["patients"] });
      toast({ title: `${eventName} נוסף כמטופל!` });
      setShowAddForm(false);
    },
    onError: (error: any) => {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    },
  });

  const patientsToShow = showAllPatients ? allPatients : suggestedPatients;

  return (
    <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-medium">{eventName}</span>
          <span className="text-sm text-muted-foreground mr-2">
            ({sessionCount} פגישות ביומן)
          </span>
        </div>
      </div>

      {/* Suggested patients for linking */}
      {suggestedPatients.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">אולי מתאים למטופל קיים?</span>
          {patientsToShow.map((patient) => (
            <div
              key={patient.id}
              className="flex items-center justify-between rounded bg-background/80 px-2 py-1.5 border"
            >
              <span className="text-sm font-medium">{patient.name}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => linkMutation.mutate(patient.id)}
                disabled={linkMutation.isPending}
                className="h-7 text-xs"
              >
                <Link2 className="ml-1 h-3 w-3" />
                שייך
              </Button>
            </div>
          ))}
          {!showAllPatients && allPatients.length > suggestedPatients.length && (
            <button
              onClick={() => setShowAllPatients(true)}
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              <ChevronDown className="h-3 w-3" />
              הצג את כל המטופלים ({allPatients.length})
            </button>
          )}
          {showAllPatients && (
            <button
              onClick={() => setShowAllPatients(false)}
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              <ChevronUp className="h-3 w-3" />
              הצג רק מומלצים
            </button>
          )}
        </div>
      )}

      {/* No suggestions - show all patients or add new */}
      {suggestedPatients.length === 0 && !showAllPatients && !showAddForm && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowAllPatients(true)}
            className="h-7 text-xs"
          >
            <Link2 className="ml-1 h-3 w-3" />
            שייך למטופל קיים
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowAddForm(true)}
            className="h-7 text-xs"
          >
            <UserPlus className="ml-1 h-3 w-3" />
            הוסף כמטופל חדש
          </Button>
        </div>
      )}

      {/* Show all patients list (when no suggestions) */}
      {suggestedPatients.length === 0 && showAllPatients && (
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">בחר מטופל לשיוך:</span>
          {allPatients.map((patient) => (
            <div
              key={patient.id}
              className="flex items-center justify-between rounded bg-background/80 px-2 py-1.5 border"
            >
              <span className="text-sm font-medium">{patient.name}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => linkMutation.mutate(patient.id)}
                disabled={linkMutation.isPending}
                className="h-7 text-xs"
              >
                <Link2 className="ml-1 h-3 w-3" />
                שייך
              </Button>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => setShowAllPatients(false)}
              className="text-xs text-muted-foreground hover:underline"
            >
              סגור
            </button>
            <button
              onClick={() => { setShowAllPatients(false); setShowAddForm(true); }}
              className="text-xs text-primary hover:underline"
            >
              או הוסף כמטופל חדש
            </button>
          </div>
        </div>
      )}

      {/* Add new patient form */}
      {showAddForm && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            addPatientMutation.mutate();
          }}
          className="flex items-end gap-2"
        >
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">טלפון</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="050-1234567"
              required
              dir="ltr"
              className="w-full h-8 px-2 text-sm rounded border bg-background"
            />
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">מחיר (₪)</label>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
              dir="ltr"
              className="w-full h-8 px-2 text-sm rounded border bg-background"
            />
          </div>
          <Button size="sm" type="submit" disabled={addPatientMutation.isPending} className="h-8">
            {addPatientMutation.isPending ? "שומר..." : "שמור"}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setShowAddForm(false)} className="h-8">
            ביטול
          </Button>
        </form>
      )}
    </div>
  );
};

export default EventAliasSuggestion;
