import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Eye, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

interface IgnoredEventsManagerProps {
  ignoredEvents: { event_name: string }[];
}

const IgnoredEventsManager = ({ ignoredEvents }: IgnoredEventsManagerProps) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);

  const restoreMutation = useMutation({
    mutationFn: async (eventName: string) => {
      const { error } = await supabase
        .from("ignored_calendar_events")
        .delete()
        .eq("therapist_id", user!.id)
        .eq("event_name", eventName);
      if (error) throw error;
      return eventName;
    },
    onSuccess: (eventName) => {
      queryClient.invalidateQueries({ queryKey: ["ignored-calendar-events"] });
      toast({ title: `"${eventName}" הוחזר לרשימה` });
    },
    onError: (error: any) => {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    },
  });

  if (ignoredEvents.length === 0) return null;

  return (
    <div className="pt-2 border-t">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        אירועים מוסתרים ({ignoredEvents.length})
      </button>
      {isOpen && (
        <div className="space-y-1 mt-2">
          {ignoredEvents.map((e) => (
            <div
              key={e.event_name}
              className="flex items-center justify-between rounded bg-muted/50 px-2 py-1.5 border border-dashed"
            >
              <span className="text-sm text-muted-foreground">{e.event_name}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => restoreMutation.mutate(e.event_name)}
                disabled={restoreMutation.isPending}
                className="h-7 text-xs"
              >
                <Eye className="ml-1 h-3 w-3" />
                בטל התעלמות
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default IgnoredEventsManager;
