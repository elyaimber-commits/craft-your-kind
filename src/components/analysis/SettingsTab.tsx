import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2 } from "lucide-react";
import type { GlobalDeduction } from "@/hooks/useAnalysisData";

interface SettingsTabProps {
  vatRate: number;
  setVatRate: (v: number) => void;
  deductions: GlobalDeduction[];
  setDeductions: (d: GlobalDeduction[]) => void;
}

export default function SettingsTab({ vatRate, setVatRate, deductions, setDeductions }: SettingsTabProps) {
  const [newName, setNewName] = useState("");

  const updateDeduction = (id: string, update: Partial<GlobalDeduction>) => {
    setDeductions(deductions.map((d) => (d.id === id ? { ...d, ...update } : d)));
  };

  const removeDeduction = (id: string) => {
    setDeductions(deductions.filter((d) => d.id !== id));
  };

  const addDeduction = () => {
    if (!newName.trim()) return;
    setDeductions([
      ...deductions,
      {
        id: `custom-${Date.now()}`,
        name: newName.trim(),
        type: "percent",
        value: 0,
        enabled: true,
      },
    ]);
    setNewName("");
  };

  return (
    <div className="space-y-6">
      {/* VAT */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">מע״מ</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Label className="whitespace-nowrap">שיעור מע״מ (%)</Label>
            <Input
              type="number"
              value={vatRate}
              onChange={(e) => setVatRate(parseFloat(e.target.value) || 0)}
              className="w-24"
              dir="ltr"
            />
          </div>
        </CardContent>
      </Card>

      {/* Deductions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">ניכויים גלובליים (ברמת חודש)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {deductions.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 p-3 rounded-lg border bg-muted/30">
              <Switch
                checked={d.enabled}
                onCheckedChange={(v) => updateDeduction(d.id, { enabled: v })}
              />
              <span className="font-medium min-w-[80px]">{d.name}</span>
              <select
                value={d.type}
                onChange={(e) => updateDeduction(d.id, { type: e.target.value as "percent" | "fixed" })}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              >
                <option value="percent">אחוז (%)</option>
                <option value="fixed">סכום קבוע (₪)</option>
              </select>
              <Input
                type="number"
                value={d.value}
                onChange={(e) => updateDeduction(d.id, { value: parseFloat(e.target.value) || 0 })}
                className="w-24"
                dir="ltr"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeDeduction(d.id)}
                className="h-8 w-8"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}

          <div className="flex items-center gap-2">
            <Input
              placeholder="שם ניכוי חדש"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="flex-1"
              onKeyDown={(e) => e.key === "Enter" && addDeduction()}
            />
            <Button variant="outline" size="sm" onClick={addDeduction}>
              <Plus className="ml-1 h-4 w-4" />
              הוסף
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
