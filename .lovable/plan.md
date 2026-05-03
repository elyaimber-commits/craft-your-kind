## Goal

When the "לא שולם" (unpaid) filter is active in the monthly billing summary, show a button that opens WhatsApp payment-request chats for every filtered unpaid patient at once.

## Background

`MonthlyBillingSummary.tsx` already has:
- A status filter with an "unpaid" option that filters `filteredBillingData`.
- A `generateWhatsAppMessage(billing)` helper that builds a `wa.me` URL with the existing payment-request text used by per-patient cards.

We can reuse both directly — no backend changes, no new memory.

## Changes

**File:** `src/components/MonthlyBillingSummary.tsx`

1. Next to the status filter buttons (line ~651-670), when `statusFilter === "unpaid"` AND `filteredBillingData.length > 0`, render a new button:
   - Label: `שלח דרישת תשלום לכולם (N)` where N = filtered unpaid count.
   - Variant: `default` with WhatsApp-style icon (use `MessageCircle` from lucide-react).
2. On click:
   - Show a confirmation `Dialog` (or `window.confirm`) listing patient names so the user knows what's about to happen.
   - On confirm, iterate `filteredBillingData` and open each `generateWhatsAppMessage(billing)` URL with `window.open(url, '_blank')`, spaced ~400ms apart so browsers don't block them as a popup burst.
   - Skip patients whose phone is empty (toast a small note about how many were skipped).
3. Show a toast at the end: `נפתחו N חלונות וואטסאפ`.

## Why a confirmation step

Opening many tabs at once is destructive UX; a quick confirm dialog showing the count + names prevents accidental mass-sends.

## Out of scope

- No automated sending — WhatsApp Web requires the user to press send in each chat (this matches the existing per-patient flow and the WhatsApp memory rule about manual `wa.me` links).
- No backend / Telegram changes.
