import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, RefreshCw, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Recommendation {
  icon: string;
  title: string;
  body: string;
}

interface AssistantResponse {
  recommendations: Recommendation[];
  context?: {
    recentHours: number;
    recentSessionsCount: number;
    newPatientsCount: number;
    gapsCount: number;
  };
  generatedAt?: string;
  error?: string;
  message?: string;
}

const PersonalAssistantCard = () => {
  const { user } = useAuth();
  const { toast } = useToast();

  const {
    data,
    isLoading,
    isFetching,
    refetch,
    error,
  } = useQuery<AssistantResponse>({
    queryKey: ["personal-assistant"],
    queryFn: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const res = await supabase.functions.invoke("personal-assistant", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (res.error) {
        const ctx: any = res.error.context;
        const status = ctx?.status;
        if (status === 429) {
          toast({
            title: "יותר מדי בקשות",
            description: "נסה שוב בעוד דקה.",
            variant: "destructive",
          });
        } else if (status === 402) {
          toast({
            title: "אין יתרה ב-AI",
            description: "הוסף יתרה דרך Settings > Workspace > Usage.",
            variant: "destructive",
          });
        }
        throw res.error;
      }
      return res.data as AssistantResponse;
    },
    enabled: !!user,
    staleTime: 1000 * 60 * 30, // 30 min — don't auto-refetch too often
    refetchOnWindowFocus: false,
  });

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sparkles className="h-5 w-5 text-primary" />
          העוזר האישי שלך
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label="רענן המלצות"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            חושב על המלצות בשבילך...
          </div>
        ) : error ? (
          <p className="text-sm text-muted-foreground">
            לא הצלחתי לטעון כרגע. נסה לרענן.
          </p>
        ) : !data?.recommendations || data.recommendations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            אין המלצות כרגע. נסה לרענן בעוד קצת.
          </p>
        ) : (
          <>
            {data.recommendations.map((rec, i) => (
              <div
                key={i}
                className="flex items-start gap-3 rounded-lg border bg-card/60 p-3"
              >
                <div className="text-2xl flex-shrink-0">{rec.icon}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{rec.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    {rec.body}
                  </p>
                </div>
              </div>
            ))}
            {data.context && (
              <p className="text-[11px] text-muted-foreground pt-1 text-center">
                מבוסס על {data.context.recentSessionsCount} פגישות,{" "}
                {data.context.recentHours} שעות עבודה השבוע
                {data.context.newPatientsCount > 0
                  ? `, ${data.context.newPatientsCount} מטופלים חדשים`
                  : ""}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default PersonalAssistantCard;
