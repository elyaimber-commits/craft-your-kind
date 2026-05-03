## מטרה
כשהפילטר הוא "לא שולם", להסתיר מטופלים שכבר נשלחה אליהם בקשת תשלום החודש (הם יישארו רק תחת "נשלחה בקשת תשלום").

## שינוי
**קובץ:** `src/components/MonthlyBillingSummary.tsx`

1. בלוגיקת הסינון (שורה 536-539) — כשהסטטוס הוא `"unpaid"`, לסנן החוצה מטופלים שמופיעים ב-`requestSentByPatient`:
   ```ts
   if (statusFilter === "unpaid") {
     return getPatientStatus(b) === "unpaid" && !requestSentByPatient.has(b.patient.id);
   }
   ```

2. בעדכון הספירות (שורה 549) — להחיל את אותו סינון על מונה ה-`unpaid` כדי שהמספר על הכפתור יתאים:
   ```ts
   unpaid: searchOnlyData.filter((b) =>
     getPatientStatus(b) === "unpaid" && !requestSentByPatient.has(b.patient.id)
   ).length,
   ```

## הערה
- מטופלים שכבר נשלחה להם בקשה יופיעו רק תחת "נשלחה בקשת תשלום". כשיסומנו כשולם — ייעלמו גם משם (כי הם מסוננים לפי החודש הנוכחי).
- כפתור "שלח דרישת תשלום לכולם" ימשיך לעבוד תקין כי הוא פועל על `filteredBillingData` המסונן.
