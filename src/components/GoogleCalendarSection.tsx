import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Calendar, Link2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const GoogleCalendarSection = () => {
  const { user } = useAuth();
  const { toast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ["google-calendar-connection-check"],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const res = await supabase.functions.invoke("google-calendar-events", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (res.error) throw res.error;
      return res.data as { error?: string };
    },
    enabled: !!user,
  });

  const connectGoogle = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const res = await supabase.functions.invoke("google-auth", {
        body: {
          userId: session.user.id,
          redirectUrl: window.location.origin + "/dashboard",
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (res.error) throw res.error;
      if (res.data?.url) {
        window.open(res.data.url, "_blank", "noopener,noreferrer");
      }
    } catch (error: any) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    }
  };

  if (isLoading) return null;

  if (data?.error === "not_connected") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Google Calendar
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-muted-foreground">חבר את יומן Google שלך כדי לראות סיכום חיוב חודשי</p>
          <Button onClick={connectGoogle}>
            <Link2 className="ml-2 h-4 w-4" />
            חבר את Google Calendar
          </Button>
        </CardContent>
      </Card>
    );
  }

  return null;
};

export default GoogleCalendarSection;
