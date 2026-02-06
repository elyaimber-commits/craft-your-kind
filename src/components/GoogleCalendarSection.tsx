import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Calendar, Link2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
}

const GoogleCalendarSection = () => {
  const { user } = useAuth();
  const { toast } = useToast();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["google-calendar-events"],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const res = await supabase.functions.invoke("google-calendar-events", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (res.error) throw res.error;
      return res.data as { events?: CalendarEvent[]; error?: string };
    },
    enabled: !!user,
  });

  const connectGoogle = async () => {
    try {
      const res = await supabase.functions.invoke("google-auth", {
        body: {
          userId: user!.id,
          redirectUrl: window.location.origin + "/dashboard",
        },
      });

      if (res.error) throw res.error;
      if (res.data?.url) {
        window.location.href = res.data.url;
      }
    } catch (error: any) {
      toast({ title: "שגיאה", description: error.message, variant: "destructive" });
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-muted-foreground">
          טוען יומן...
        </CardContent>
      </Card>
    );
  }

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
          <p className="mb-4 text-muted-foreground">חבר את יומן Google שלך כדי לראות פגישות קרובות</p>
          <Button onClick={connectGoogle}>
            <Link2 className="ml-2 h-4 w-4" />
            חבר את Google Calendar
          </Button>
        </CardContent>
      </Card>
    );
  }

  const events = data?.events || [];

  const formatTime = (event: CalendarEvent) => {
    if (event.start.dateTime) {
      return new Date(event.start.dateTime).toLocaleString("he-IL", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    if (event.start.date) {
      return new Date(event.start.date).toLocaleDateString("he-IL", {
        weekday: "short",
        day: "numeric",
        month: "short",
      });
    }
    return "";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          פגישות קרובות (7 ימים)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-muted-foreground">אין פגישות קרובות</p>
        ) : (
          <div className="space-y-2">
            {events.slice(0, 10).map((event) => (
              <div key={event.id} className="flex items-center justify-between rounded-md border p-3">
                <span className="font-medium">{event.summary || "(ללא כותרת)"}</span>
                <span className="text-sm text-muted-foreground" dir="ltr">{formatTime(event)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default GoogleCalendarSection;
