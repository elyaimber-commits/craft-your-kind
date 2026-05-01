import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Folder, Loader2, Search, Check } from "lucide-react";

interface DriveFolder {
  id: string;
  name: string;
  modifiedTime?: string;
}

interface DriveFolderPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patientId: string;
  patientName: string;
  currentFolderId?: string | null;
  currentFolderName?: string | null;
  onSaved?: (folderId: string, folderName: string) => void;
}

const DriveFolderPickerDialog = ({
  open,
  onOpenChange,
  patientId,
  patientName,
  currentFolderId,
  currentFolderName,
  onSaved,
}: DriveFolderPickerDialogProps) => {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const search = async (q: string) => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("google-drive-folders", {
        method: "GET" as any,
        // supabase-js v2 doesn't pass query string with invoke; build URL manually below
      } as any).catch(() => ({ data: null, error: null } as any));

      // Fallback: use direct fetch to support query params
      const { data: { session } } = await supabase.auth.getSession();
      const url = new URL(
        `https://${import.meta.env.VITE_SUPABASE_PROJECT_ID}.supabase.co/functions/v1/google-drive-folders`,
      );
      if (q) url.searchParams.set("q", q);
      const resp = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${session?.access_token ?? ""}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error || "שגיאה בטעינת תיקיות");
      setFolders(json.folders || []);
    } catch (e: any) {
      console.error(e);
      toast({
        title: "שגיאה בטעינת תיקיות מ-Google Drive",
        description: e?.message || "ודא שחיברת את Google ושאישרת גישה ל-Drive",
        variant: "destructive",
      });
      setFolders([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setQuery("");
      search("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pickFolder = async (folder: DriveFolder) => {
    setSaving(folder.id);
    try {
      const { error } = await supabase
        .from("patients")
        .update({
          drive_folder_id: folder.id,
          drive_folder_name: folder.name,
        })
        .eq("id", patientId);
      if (error) throw error;
      toast({ title: `התיקייה "${folder.name}" הוגדרה ל${patientName}` });
      onSaved?.(folder.id, folder.name);
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "שגיאה", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  const clearFolder = async () => {
    setSaving("__clear__");
    try {
      const { error } = await supabase
        .from("patients")
        .update({ drive_folder_id: null, drive_folder_name: null })
        .eq("id", patientId);
      if (error) throw error;
      toast({ title: "התיקייה הוסרה" });
      onSaved?.("", "");
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "שגיאה", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>בחירת תיקיית Google Drive — {patientName}</DialogTitle>
        </DialogHeader>

        {currentFolderName && (
          <div className="rounded-md bg-muted px-3 py-2 text-sm flex items-center justify-between">
            <span>
              <Folder className="inline h-4 w-4 ml-1" /> נוכחית: <b>{currentFolderName}</b>
            </span>
            <Button size="sm" variant="ghost" onClick={clearFolder} disabled={saving !== null}>
              הסר
            </Button>
          </div>
        )}

        <div className="flex gap-2">
          <Input
            placeholder="חיפוש תיקייה..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search(query)}
          />
          <Button onClick={() => search(query)} disabled={loading} variant="outline">
            <Search className="h-4 w-4" />
          </Button>
        </div>

        <div className="max-h-[400px] overflow-y-auto border rounded-md">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin ml-2" />
              טוען...
            </div>
          ) : folders.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              לא נמצאו תיקיות. נסה חיפוש אחר.
            </div>
          ) : (
            <ul className="divide-y">
              {folders.map((f) => (
                <li key={f.id}>
                  <button
                    onClick={() => pickFolder(f)}
                    disabled={saving !== null}
                    className="w-full flex items-center gap-2 px-3 py-2 text-right hover:bg-muted disabled:opacity-50"
                  >
                    {saving === f.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : f.id === currentFolderId ? (
                      <Check className="h-4 w-4 text-green-600" />
                    ) : (
                      <Folder className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="flex-1">{f.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          רואים רק תיקיות שיצרת או שיש לך גישה אליהן ב-Drive.
        </p>
      </DialogContent>
    </Dialog>
  );
};

export default DriveFolderPickerDialog;
