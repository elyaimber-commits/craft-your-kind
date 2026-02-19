# CLAUDE.md — Codebase Guide

## Project Overview

**craft-your-kind** is a patient management and billing application for therapists, built in Hebrew with RTL layout. It integrates with Google Calendar to automatically detect therapy sessions via calendar event color-coding and generate monthly billing summaries.

The app is hosted on the [Lovable](https://lovable.dev) platform and uses Supabase as its backend.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Build tool | Vite 5 + `@vitejs/plugin-react-swc` |
| Language | TypeScript 5 |
| UI framework | React 18 |
| Styling | Tailwind CSS 3 + shadcn/ui (Radix UI) |
| Backend / Auth | Supabase (PostgreSQL + Edge Functions + Auth) |
| Data fetching | TanStack Query (React Query) v5 |
| Routing | React Router DOM v6 |
| Charts | Recharts |
| Forms | React Hook Form + Zod |
| PWA | vite-plugin-pwa (service worker, installable) |
| Testing | Vitest + @testing-library/react + jsdom |

---

## Development Commands

```bash
npm run dev          # Start dev server at http://localhost:8080
npm run build        # Production build
npm run build:dev    # Development-mode build
npm run lint         # Run ESLint
npm test             # Run tests (Vitest)
npm run test:watch   # Run tests in watch mode
npm run preview      # Preview production build locally
```

The dev server binds to `::` (all interfaces) on port **8080**.

---

## Project Structure

```
src/
  main.tsx                      # App entry point
  App.tsx                       # Root component — router, providers, global toasters
  App.css / index.css           # Global styles

  pages/                        # One file per route
    Auth.tsx                    # / — Login/signup page
    Dashboard.tsx               # /dashboard — Main dashboard
    PaymentHistory.tsx          # /payments — Payment history
    Analysis.tsx                # /analysis — Monthly financial analysis
    WeeklyFinance.tsx           # /weekly-finance — Weekly income/expense grid
    NotFound.tsx                # * — 404 fallback

  components/
    ProtectedRoute.tsx          # Auth guard wrapper
    GoogleCalendarSection.tsx   # Shows connect button when Google not linked
    MonthlyBillingSummary.tsx   # Core billing view — reads calendar + payments
    PatientBillingCard.tsx      # Per-patient billing row (expandable)
    EventAliasSuggestion.tsx    # Suggests linking unmatched calendar events
    NewPatientSuggestion.tsx    # Suggests creating patient from unmatched event
    RevenueChart.tsx            # Monthly revenue bar chart
    DataExport.tsx              # CSV/JSON export of patients + payments
    NavLink.tsx                 # Navigation link helper
    analysis/
      SummaryTab.tsx            # Monthly totals tab
      PerPatientTab.tsx         # Per-patient breakdown tab
      SettingsTab.tsx           # VAT rate + global deductions settings
    ui/                         # shadcn/ui auto-generated components (do not edit manually)

  hooks/
    useAuth.tsx                 # Auth state — subscribes to Supabase auth events
    useAnalysisData.ts          # Data fetching + financial computation for Analysis page
    use-mobile.tsx              # Mobile breakpoint detection
    use-toast.ts                # Toast notification hook

  integrations/
    supabase/
      client.ts                 # Supabase client singleton
      types.ts                  # Auto-generated DB types (do not edit manually)

  lib/
    utils.ts                    # `cn()` utility (clsx + tailwind-merge)

  test/
    setup.ts                    # Vitest test setup (@testing-library/jest-dom)
    example.test.ts             # Example test file

supabase/
  config.toml                   # Supabase project config (project_id, edge function JWT settings)
  migrations/                   # Sequential SQL migration files (timestamped)
```

---

## Routing

All protected routes are wrapped in `<ProtectedRoute>` which redirects unauthenticated users to `/`.

| Route | Component | Description |
|---|---|---|
| `/` | `Auth` | Login / signup |
| `/dashboard` | `Dashboard` | Patient list + monthly billing summary + revenue chart |
| `/payments` | `PaymentHistory` | Full payment history |
| `/analysis` | `Analysis` | Monthly financial analysis with VAT/commission/deduction breakdown |
| `/weekly-finance` | `WeeklyFinance` | Weekly income grid with per-day expenses |
| `*` | `NotFound` | 404 page |

---

## Database Schema

All tables use `therapist_id UUID` for row-level multi-tenancy. Row Level Security (RLS) is enabled on every table.

### `patients`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `therapist_id` | UUID | Auth user ID |
| `name` | TEXT | Used for matching calendar events |
| `phone` | TEXT | |
| `session_price` | NUMERIC | Default price per session |
| `billing_type` | TEXT | `monthly` \| `per_session` \| `institution` |
| `parent_patient_id` | UUID? | FK to `patients.id` — links child to institution |
| `commission_enabled` | BOOLEAN | |
| `commission_type` | TEXT | `percent` \| `fixed` |
| `commission_value` | NUMERIC? | |
| `green_invoice_customer_id` | TEXT? | Integration with Green Invoice (Israeli invoicing) |

### `payments`
| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `therapist_id` | UUID | |
| `patient_id` | UUID FK → patients | |
| `month` | TEXT | Format: `YYYY-MM` |
| `amount` | NUMERIC | |
| `session_count` | INTEGER | |
| `paid` | BOOLEAN | |
| `paid_at` | TIMESTAMPTZ? | |
| `paid_event_ids` | TEXT[]? | Google Calendar event IDs that are marked paid |
| `status` | TEXT | `pending` \| `paid` \| `refunded` \| `canceled` |
| `notes` | TEXT? | |
| `external_payment_id` | TEXT? | |
| `external_source` | TEXT? | |
| `receipt_number` | TEXT? | |

### `event_aliases`
Maps Google Calendar event summary text to a patient when names don't match exactly.
- `event_name` TEXT — the calendar event title
- `patient_id` UUID FK → patients

### `ignored_calendar_events`
Calendar event names to exclude from billing matching.
- `event_name` TEXT

### `session_overrides`
Per-event custom pricing overrides.
- `event_id` TEXT — Google Calendar event ID
- `patient_id` UUID FK → patients
- `custom_price` NUMERIC

### `google_tokens`
Stores OAuth refresh/access tokens for Google Calendar.
- `user_id` UUID
- `access_token`, `refresh_token`, `expires_at`

### `daily_expenses`
Per-day expense tracking used in the Weekly Finance page.
- `date` DATE
- `slot_index` INTEGER (0–3, up to 4 expenses per day)
- `name` TEXT
- `amount` NUMERIC
- Unique constraint: `(therapist_id, date, slot_index)`

---

## Supabase Edge Functions

Defined in `supabase/config.toml`. All have `verify_jwt = false` (auth is handled manually via `Authorization: Bearer <token>` header).

| Function | Purpose |
|---|---|
| `google-auth` | Initiates Google OAuth flow, returns redirect URL |
| `google-callback` | Handles Google OAuth callback, stores tokens |
| `google-calendar-events` | Checks if Google Calendar is connected |
| `google-calendar-billing` | Fetches calendar events for a given month |
| `google-calendar-update-colors` | Updates event color IDs in Google Calendar |
| `google-calendar-rename-events` | Renames events when a patient name changes |
| `green-invoice-webhook` | Receives webhooks from Green Invoice (Israeli invoicing) |

---

## Google Calendar Color-Coding Convention

The app derives billing status from Google Calendar event colors:

| Color | ID | Meaning |
|---|---|---|
| Default (none) | `undefined` | Session done, billing pending |
| Yellow (Banana) | `"5"` | Session done + notes written |
| Red (Flamingo) | `"4"` | Cancelled — excluded from billing |
| Purple (Grape) | `"3"` | Paid — auto-syncs to `paid` status in DB |

Events with color `"3"` (purple) are automatically synced to `paid_event_ids` in the `payments` table when `MonthlyBillingSummary` loads.

---

## Patient-to-Event Matching Logic

Defined in `src/components/MonthlyBillingSummary.tsx`:

1. **Normalization** (`normalizeName`): Trim → collapse whitespace → lowercase → strip Hebrew diacritics (nikud `\u0591–\u05C7`) → collapse duplicate consecutive characters.
2. **Exact match**: Normalized patient name === normalized event summary.
3. **Alias match**: Look up normalized event name in `event_aliases` table → get `patient_id`.
4. **Partial match** (for suggestions only): Word overlap or substring containment.

---

## Financial Calculation Logic

Defined in `src/hooks/useAnalysisData.ts` — `computeAnalysis()`:

1. Filter payments (optionally include refunds/cancellations).
2. Group by patient.
3. Per patient: `gross → vat (gross × r/(1+r)) → base (gross − vat) → commission → netAfterCommission`.
4. Global deductions (percent of `monthBaseAfterVAT` or fixed amount) applied to total.
5. `net = monthBaseAfterVAT − globalDeductionsTotal − commissionsTotal`.

VAT rate defaults to **17%** (Israeli standard). Stored in `localStorage` key `analysis-vat-rate`. Deductions stored in `localStorage` key `analysis-deductions`.

---

## Key Conventions

### RTL Layout
All page-level containers use `dir="rtl"`. Directional inputs (phones, numbers) use `dir="ltr"` individually. Hebrew is the primary UI language.

### Path Alias
Use `@/` for all imports from `src/`. Example: `import { supabase } from "@/integrations/supabase/client"`.

### Component Patterns
- Pages fetch data directly using `useQuery` from TanStack Query.
- Mutations use `useMutation` + `queryClient.invalidateQueries()` for cache invalidation.
- Auth state comes from `useAuth()` hook — provides `user`, `loading`, `signOut`.
- Toast notifications use `useToast()` hook.

### Supabase Access
Always import the singleton: `import { supabase } from "@/integrations/supabase/client"`. Never create a new client instance.

For edge function calls requiring auth, pass the session token:
```ts
const { data: { session } } = await supabase.auth.getSession();
await supabase.functions.invoke("function-name", {
  headers: { Authorization: `Bearer ${session.access_token}` },
  body: { ... },
});
```

### shadcn/ui Components
All UI primitives live in `src/components/ui/`. These are generated by the shadcn CLI and should not be modified directly. Use them by importing: `import { Button } from "@/components/ui/button"`.

### Billing Types
- `monthly` — flat monthly charge regardless of session count
- `per_session` — charged per individual session
- `institution` — an organization (e.g., school); child patients link to it via `parent_patient_id`; billing aggregates all children's sessions

### Commission
Per-patient commissions deducted from the therapist's income:
- `percent` — e.g., `10` means 10% of gross
- `fixed` — fixed shekel amount per patient per month

### Month Format
All month references use `YYYY-MM` string format (e.g., `"2026-02"`). Timezone handling is Israel time (`Asia/Jerusalem`).

---

## Testing

Tests live in `src/**/*.{test,spec}.{ts,tsx}` and use Vitest + jsdom + Testing Library.

```bash
npm test             # Single run
npm run test:watch   # Watch mode
```

Setup file: `src/test/setup.ts` — imports `@testing-library/jest-dom` matchers.

---

## Environment Variables

Configured via `.env`. The Supabase client in `src/integrations/supabase/client.ts` reads:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

---

## PWA Configuration

The app is a Progressive Web App configured in `vite.config.ts` using `vite-plugin-pwa`:
- Auto-updates on new deploy
- Caches Supabase API responses with a 1-hour TTL (NetworkFirst strategy)
- App name: "ניהול מטופלים" (Patient Management)
- Installable on mobile as standalone app

---

## Database Migrations

Located in `supabase/migrations/`. Each file is named `YYYYMMDDHHMMSS_<uuid>.sql`. When adding new schema changes, create a new migration file — never edit existing ones.

---

## Common Patterns to Follow

1. **Never break RLS**: Every new table must have `therapist_id` column + RLS policies that check `auth.uid() = therapist_id`.
2. **Invalidate query cache after mutations**: Always call `queryClient.invalidateQueries({ queryKey: [...] })` in `onSuccess`.
3. **Use `useQuery` with `enabled: !!user`**: Prevents queries from running before auth is ready.
4. **Hebrew UI strings**: Keep all user-facing strings in Hebrew. Error messages, labels, toasts — all Hebrew.
5. **Numbers in RTL**: Monetary values (₪) and dates should use `dir="ltr"` within the RTL page to render correctly.
6. **Session price override**: Always check `overrideMap` before using `patient.session_price` for individual calendar events.
