import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Mic, Square, RotateCcw, Loader2, Download, Sparkles, Cloud, FolderCog } from "lucide-react";
import DriveFolderPickerDialog from "./DriveFolderPickerDialog";

interface SessionNoteRecorderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patientId: string;
  patientName: string;
  sessionDate: string; // display, e.g. "5/4/26"
  driveFolderId?: string | null;
  driveFolderName?: string | null;
  onFolderUpdated?: (folderId: string, folderName: string) => void;
}

type Phase = "idle" | "recording" | "recorded" | "processing" | "done";

const MAX_SECONDS = 5 * 60; // 5 minutes

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/mpeg",
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function formatTime(s: number) {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

const SessionNoteRecorderDialog = ({
  open,
  onOpenChange,
  patientId,
  patientName,
  sessionDate,
  driveFolderId,
  driveFolderName,
  onFolderUpdated,
}: SessionNoteRecorderDialogProps) => {
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [cleaned, setCleaned] = useState("");
  const [savingToDrive, setSavingToDrive] = useState(false);
  const [savedToDrive, setSavedToDrive] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const mimeRef = useRef<string>("");
  const timerRef = useRef<number | null>(null);

  // Reset everything when dialog closes
  useEffect(() => {
    if (!open) {
      stopTimer();
      stopStream();
      mediaRecorderRef.current = null;
      chunksRef.current = [];
      blobRef.current = null;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
      setCleaned("");
      setSeconds(0);
      setPhase("idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const stopTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = pickMimeType();
      mimeRef.current = mimeType;
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeRef.current || "audio/webm" });
        blobRef.current = blob;
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        stopStream();
        setPhase("recorded");
      };

      mr.start();
      setSeconds(0);
      setPhase("recording");
      timerRef.current = window.setInterval(() => {
        setSeconds((s) => {
          const next = s + 1;
          if (next >= MAX_SECONDS) {
            stopRecording();
          }
          return next;
        });
      }, 1000);
    } catch (e: any) {
      console.error(e);
      toast({
        title: "לא ניתן לגשת למיקרופון",
        description: e?.message || "בדוק הרשאות מיקרופון בדפדפן",
        variant: "destructive",
      });
    }
  };

  const stopRecording = () => {
    stopTimer();
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.stop();
    }
  };

  const reset = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    blobRef.current = null;
    chunksRef.current = [];
    setSeconds(0);
    setCleaned("");
    setPhase("idle");
  };

  const transcribe = async () => {
    const blob = blobRef.current;
    if (!blob) return;
    setPhase("processing");
    try {
      const ext = (mimeRef.current.includes("mp4") || mimeRef.current.includes("mpeg"))
        ? "m4a"
        : "webm";
      const file = new File([blob], `note.${ext}`, { type: blob.type });
      const form = new FormData();
      form.append("audio", file);

      const { data, error } = await supabase.functions.invoke("transcribe-and-clean", {
        body: form,
      });

      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      const text = (data as any)?.cleaned || (data as any)?.raw || "";
      setCleaned(text);

      // Discard the audio blob — we don't keep it
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
      blobRef.current = null;
      chunksRef.current = [];

      setPhase("done");
      if ((data as any)?.warning === "cleaning_failed") {
        toast({
          title: "ניקוי הטקסט נכשל",
          description: "הצגתי את התמלול הגולמי. ניתן לערוך אותו ידנית.",
        });
      }
    } catch (e: any) {
      console.error(e);
      setPhase("recorded");
      toast({
        title: "שגיאה בתמלול",
        description: e?.message || "נסה שוב",
        variant: "destructive",
      });
    }
  };

  const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "-").trim();
  const downloadTxt = () => {
    if (!cleaned.trim()) return;
    const filename = `${safeName(patientName)}_${safeName(sessionDate)}.txt`;
    const blob = new Blob([cleaned], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const filenameForFile = () => `${safeName(patientName)}_${safeName(sessionDate)}.txt`;

  const saveToDrive = async () => {
    if (!cleaned.trim()) return;
    if (!driveFolderId) {
      setFolderPickerOpen(true);
      return;
    }
    setSavingToDrive(true);
    try {
      const { data, error } = await supabase.functions.invoke("google-drive-upload", {
        body: {
          folderId: driveFolderId,
          filename: filenameForFile(),
          content: cleaned,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      setSavedToDrive(true);
      toast({
        title: "נשמר ב-Drive ✓",
        description: `${(data as any)?.name || filenameForFile()} → ${driveFolderName}`,
      });
    } catch (e: any) {
      console.error(e);
      toast({
        title: "שמירה ל-Drive נכשלה",
        description: e?.message || "ודא שחיברת את Google מחדש לאחר עדכון ההרשאות",
        variant: "destructive",
      });
    } finally {
      setSavingToDrive(false);
    }
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            סיכום פגישה — {patientName} · <span dir="ltr">{sessionDate}</span>
          </DialogTitle>
        </DialogHeader>

        {/* Recorder */}
        {(phase === "idle" || phase === "recording" || phase === "recorded" || phase === "processing") && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="text-4xl font-mono tabular-nums" dir="ltr">
              {formatTime(seconds)}
            </div>
            <div className="text-xs text-muted-foreground">מקסימום 5 דקות</div>

            {phase === "idle" && (
              <Button size="lg" onClick={startRecording} className="gap-2">
                <Mic className="h-5 w-5" /> התחל הקלטה
              </Button>
            )}

            {phase === "recording" && (
              <Button size="lg" variant="destructive" onClick={stopRecording} className="gap-2">
                <Square className="h-5 w-5" /> עצור
              </Button>
            )}

            {phase === "recorded" && audioUrl && (
              <div className="w-full space-y-3">
                <audio src={audioUrl} controls className="w-full" />
                <div className="flex justify-center gap-2">
                  <Button variant="outline" onClick={reset} className="gap-2">
                    <RotateCcw className="h-4 w-4" /> הקלט מחדש
                  </Button>
                  <Button onClick={transcribe} className="gap-2">
                    <Sparkles className="h-4 w-4" /> תמלל ונקה
                  </Button>
                </div>
              </div>
            )}

            {phase === "processing" && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                מתמלל ומנקה... (עד דקה)
              </div>
            )}
          </div>
        )}

        {/* Result */}
        {phase === "done" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm text-muted-foreground">
                ניתן לערוך את הטקסט לפני השמירה. האודיו נמחק.
              </p>
              <button
                type="button"
                onClick={() => setFolderPickerOpen(true)}
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline"
              >
                <FolderCog className="h-3 w-3" />
                {driveFolderName ? `תיקייה: ${driveFolderName}` : "הגדר תיקיית Drive"}
              </button>
            </div>
            <Textarea
              value={cleaned}
              onChange={(e) => { setCleaned(e.target.value); setSavedToDrive(false); }}
              className="min-h-[300px] text-base leading-relaxed"
              dir="rtl"
            />
            <div className="flex justify-between flex-wrap gap-2">
              <Button variant="outline" onClick={reset} className="gap-2">
                <RotateCcw className="h-4 w-4" /> הקלטה חדשה
              </Button>
              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  סגור
                </Button>
                <Button variant="outline" onClick={downloadTxt} disabled={!cleaned.trim()} className="gap-2">
                  <Download className="h-4 w-4" /> הורד
                </Button>
                <Button
                  onClick={saveToDrive}
                  disabled={!cleaned.trim() || savingToDrive}
                  className="gap-2"
                >
                  {savingToDrive ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Cloud className="h-4 w-4" />
                  )}
                  {savedToDrive ? "נשמר ✓" : driveFolderId ? "שמור ל-Drive" : "בחר תיקייה ושמור"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>

    <DriveFolderPickerDialog
      open={folderPickerOpen}
      onOpenChange={setFolderPickerOpen}
      patientId={patientId}
      patientName={patientName}
      currentFolderId={driveFolderId}
      currentFolderName={driveFolderName}
      onSaved={(fid, fname) => {
        onFolderUpdated?.(fid, fname);
        // If we have content and just picked a folder, save right away
        if (fid && cleaned.trim()) {
          // small delay so the parent prop updates propagate
          setTimeout(() => saveToDrive(), 100);
        }
      }}
    />
    </>
  );
};

export default SessionNoteRecorderDialog;
