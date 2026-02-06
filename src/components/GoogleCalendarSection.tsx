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
  colorId?: string;
  calendarColor?: string;
}

// Google Calendar colorId mapping to status
// Green (2, 10) = נקבע, Red/Pink (4, 11) = בוטל, Yellow (5) = בוצע
const getEventStyle = (event: CalendarEvent) => {
  const colorId = event.colorId;
  switch (colorId) {
    case "2":
    case "10":
      return { border: "border-l-4 border-l-green-500 bg-green-50", label: "נקבע" };
    case "4":
    case "11":
      return { border: "border-l-4 border-l-red-500 bg-red-50", label: "בוטל" };
    case "5":
      return { border: "border-l-4 border-l-yellow-500 bg-yellow-50", label: "בוצע" };
    default:
      return { border: "border-l-4 border-l-blue-400 bg-background", label: "" };
  }
};

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
            {events.slice(0, 20).map((event) => {
              const style = getEventStyle(event);
              return (
                <div key={event.id} className={`flex items-center justify-between rounded-md border p-3 ${style.border}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{event.summary || "(ללא כותרת)"}</span>
                    {style.label && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-background/80 text-muted-foreground">
                        {style.label}
                      </span>
                    )}
                  </div>
                  <span className="text-sm text-muted-foreground" dir="ltr">{formatTime(event)}</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default GoogleCalendarSection;
