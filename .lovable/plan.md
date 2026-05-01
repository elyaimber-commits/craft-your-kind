## רקע
ה-Webhook ב-Morning מוגדר נכון (`document/created` → ה-URL שלנו), אבל הסטטוס "לא פעיל" כי הקריאה הראשונה (כנראה ping מאומתת ע"י Morning) נכשלה עם `SyntaxError: Unexpected end of JSON input`. הפונקציה שלנו מנסה לפרסר JSON גם כשה-body ריק.

## שינויים

### 1. תיקון `supabase/functions/green-invoice-webhook/index.ts`
- לקרוא `req.text()` במקום `req.json()`
- אם ה-body ריק → להחזיר `200 OK` (ping handshake) במקום לקרוס
- אם JSON לא תקין → להחזיר `400` עם הודעה ברורה (לא 500)
- לוג מפורט של כל payload ב-`console.log` ובטבלת `webhook_logs`
- להחזיר `200` גם כשהמטופל לא נמצא (אחרת Morning תסמן את ה-webhook כשבור), אבל לתעד את זה

### 2. טבלה חדשה `webhook_logs` (מיגרציה)
שדות: `id`, `source`, `received_at`, `status_code`, `event_type`, `external_payment_id`, `matched_patient_id`, `error`, `payload jsonb`
RLS: select רק למשתמש המאומת, insert רק ל-service role.

### 3. עדכון `GreenInvoiceWebhookCard` בדשבורד
- "פעיל" אם הייתה קריאה כלשהי ב-7 הימים האחרונים (לא רק תשלום)
- שורה חדשה: "קריאות אחרונות: X הצליחו, Y נכשלו (24ש)"
- כפתור "הצג לוגים" שפותח דיאלוג עם 20 הקריאות האחרונות מ-`webhook_logs`

### 4. ודאות שאין דרישת JWT
לוודא שב-`supabase/config.toml` יש `verify_jwt = false` לפונקציה (כנראה כבר קיים, רק לאמת).

## בדיקה אחרי הפריסה
1. ב-Morning → Webhooks → ללחוץ "שלח בדיקה" (אם קיים) או ליצור חשבונית-קבלה אמיתית קטנה
2. סטטוס ב-Morning אמור להפוך ל"פעיל"
3. בדשבורד → לפתוח דיאלוג הלוגים ולראות את הקריאה
4. אם המטופל זוהה — לבדוק ב-`payments` שהרשומה נוצרה

## מה לא משתנה
- לוגיקת המיפוי `green_invoice_customer_id` → `patient_id` נשארת זהה
- הכפתור "העתק URL" וההצגה של מטופלים חסרי ID נשארים כפי שהם
