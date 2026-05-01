# הקלטת סיכום פגישה → תמלול → ניקוי → הורדה

## תהליך משתמש
1. ליד התאריך של כל פגישה ב-`PatientBillingCard` יופיע כפתור מיקרופון 🎙️.
2. לחיצה פותחת דיאלוג: **התחל הקלטה / עצור / השמע / הקלט מחדש** + טיימר.
3. בלחיצה על "תמלל ונקה": האודיו נשלח לאדג'-פונקשן, מתבצע תמלול ב-OpenAI ואז ניקוי ב-OpenAI לפי ההנחיה שניתנה.
4. הטקסט הנקי מוצג ב-Textarea ניתן לעריכה.
5. כפתור **הורד כ-TXT** (שם קובץ: `שם-מטופל_תאריך.txt`) וכפתור **סגור**.
6. אין שמירה ב-DB. האודיו נמחק מיד לאחר הניקוי (לא נשמר כלל בצד שרת — רק עובר דרך הפונקציה).

## דרישת מפתח
זקוקים ל-`OPENAI_API_KEY`. אבקש אותו בכלי הסודות לפני הוספת הקוד.

## חלקים טכניים

**Edge Function חדש: `transcribe-and-clean`**
- `verify_jwt = false` בקונפיג + ולידציית JWT בקוד (כמו שאר הפונקציות בפרויקט).
- מקבל: `multipart/form-data` עם שדה `audio` (Blob webm/mp4).
- שלב א': `POST https://api.openai.com/v1/audio/transcriptions` עם `model=gpt-4o-mini-transcribe`, `language=he`, הקובץ.
- שלב ב': `POST https://api.openai.com/v1/chat/completions` עם `gpt-4o-mini`, system = הנחיית הניקוי המדויקת מהבקשה, user = התמלול הגולמי.
- מחזיר `{ raw, cleaned }`. לא כותב לדיסק, האודיו ב-RAM בלבד ומשוחרר עם סיום הבקשה.
- טיפול בשגיאות 401/429/402 עם הודעות ברורות.

**קומפוננטה חדשה: `SessionNoteRecorderDialog.tsx`**
- `MediaRecorder` API להקלטה (mime: `audio/webm;codecs=opus` עם fallback ל-`audio/mp4` לספארי/iOS — קריטי ל-PWA באייפון).
- מצבים: `idle | recording | recorded | processing | done`.
- טיימר MM:SS, מקסימום 5 דקות (עוצר אוטומטית).
- שולח ל-edge function דרך `supabase.functions.invoke` עם `FormData`.
- Textarea `min-h-[300px]` עם הטקסט הנקי, ניתן לעריכה לפני ההורדה.
- כפתור הורדה יוצר Blob טקסט ומוריד דרך `<a download>`.

**שינוי ב-`PatientBillingCard.tsx`**
- ליד `{formatDate(session.date)}` של כל שורת פגישה: כפתור אייקון `Mic` קטן (ghost, h-7 w-7).
- State: `recordingSession: Session | null` שפותח את הדיאלוג עם הקשר (שם מטופל + תאריך לשם הקובץ).

## קבצים שייווצרו / יישתנו
- `supabase/functions/transcribe-and-clean/index.ts` — חדש
- `supabase/config.toml` — בלוק `[functions.transcribe-and-clean]` עם `verify_jwt = false`
- `src/components/SessionNoteRecorderDialog.tsx` — חדש
- `src/components/PatientBillingCard.tsx` — הוספת כפתור מיקרופון + state
- `mem://features/session-voice-notes` + עדכון index

## סדר ביצוע
1. בקשת `OPENAI_API_KEY` (ממתין לאישור המשתמש).
2. יצירת ה-edge function והקונפיג.
3. יצירת הדיאלוג והשילוב ב-PatientBillingCard.
4. עדכון זיכרון.

## הערות
- הקלטה מהדפדפן דורשת הרשאת מיקרופון (HTTPS — קיים ב-preview/published).
- ב-iOS Safari: חובה `audio/mp4`; אטפל ב-fallback אוטומטית.
- אין אחסון בענן — מתאים לדרישה "מחק אודיו אחרי עיבוד".
