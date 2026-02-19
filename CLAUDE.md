# CLAUDE.md — Codebase Guide

## Project Overview

A **macOS SwiftUI app** for clinical psychologists and therapists to assess and diagnose patients using the **PDM-3 (Psychodiagnostic Manual, 3rd Edition)** framework. The app is written entirely in Hebrew and supports:

- **M Axis** — Profile of Mental Functioning (13 capacities, per PDM-3)
- **P Axis** — Personality Styles (13 prototypes based on PDM-3 empirical profiles)
- Local persistence of patient records (JSON on disk, no server)

---

## Tech Stack

| Component | Technology |
|---|---|
| Language | Swift 5.9+ |
| UI Framework | SwiftUI |
| State Management | `@StateObject`, `@EnvironmentObject`, `@Published` |
| Persistence | JSON file on disk (`ApplicationSupport/diagnostic/data.json`) |
| Reactive updates | Combine (`ObservableObject`) |
| Target | macOS (NavigationSplitView layout) |

---

## Architecture

The entire app lives in a **single file** (currently). The main components are:

```
Data Models
  Patient                  — top-level record (id, name, mAxisScores, timestamps)
  MAxisScores              — 13 PDM-3 M Axis capacities (Double 1–5 each)
  MentalFunctioningLevel   — enum derived from totalScore (M1–M7)
  PersonalityStyle         — enum of 13 P Axis prototypes
  PrototypeMatch           — result of diagnostic engine (style + score + explanation)

Data Layer
  LocalStore (ObservableObject)
    @Published patients: [Patient]
    @Published selectedPatientID: UUID?
    addPatient(name:)
    updateMAxisScores(_:)
    renameSelected(to:)
    deleteSelected()
    load() / save()          — JSON encode/decode to disk

UI
  ContentView              — root (NavigationSplitView: sidebar + detail)
  PatientDetailView        — 3-tab view per patient
    Tab 0: assessmentTab   — 13 MAxisSliderRow sliders
    Tab 1: summaryTab      — readable clinical summary text
    Tab 2: diagnosisTab    — top-5 personality style matches + level
  BookBrowserView          — PDM-3 reference browser (sidebar button)

Diagnostic Engine
  suggestPersonalityStyles(from:) — Euclidean distance from patient M Axis
                                    profile to each style's typicalMAxisProfile

Metadata
  mAxisScaleDefs: [MAxisScaleDefinition]   — 13 slider definitions (title, labels)
  PersonalityStyle.typicalMAxisProfile     — reference profiles for matching
  PersonalityStyle.fullPrototypeText       — full PDM-3 empirical prototype text

UI Components
  Card                     — styled container (rounded rect + shadow)
  MAxisSliderRow           — single capacity slider with labels
  RadarChart               — spider/radar chart (5-axis, currently unused)
```

---

## Data Model Details

### `Patient`
```swift
struct Patient: Identifiable, Codable, Equatable {
    var id: UUID
    var name: String
    var createdAt: Date
    var lastUpdatedAt: Date
    var mAxisScores: MAxisScores   // PDM-3 M Axis — the active model
}
```

### `MAxisScores`
13 capacities, each a `Double` in range **1.0–5.0**:
- `1` = significant impairment
- `5` = healthy/stable functioning

| # | Property | Clinical Meaning |
|---|---|---|
| 1 | `capacity1_AttentionLearning` | Executive functioning, attention, working memory |
| 2 | `capacity2_AffectRegulation` | Affect regulation and expression |
| 3 | `capacity3_Mentalization` | Understanding mental states in self/others |
| 4 | `capacity4_BodilyExperiences` | Bodily experiences and representations |
| 5 | `capacity5_DifferentiationIntegration` | Self/other differentiation and integration |
| 6 | `capacity6_SelfEsteemRegulation` | Self-esteem regulation |
| 7 | `capacity7_TrustEmpathyIntimacy` | Trust, empathy, and intimacy |
| 8 | `capacity8_ImpulseRegulation` | Impulse regulation |
| 9 | `capacity9_DefensiveFunctioning` | Defensive functioning |
| 10 | `capacity10_AdaptationResilience` | Adaptation and resilience |
| 11 | `capacity11_InternalStandards` | Internal standards and ideals |
| 12 | `capacity12_InnerLifeExploration` | Capacity to explore inner life |
| 13 | `capacity13_AgencyPurpose` | Sense of agency and purpose |

**Computed properties:**
- `totalScore: Int` — sum of all 13 (range 13–65)
- `average: Double` — mean of 13 values
- `mentalFunctioningLevel: MentalFunctioningLevel` — derived from `totalScore`

### `MentalFunctioningLevel` (PDM-3 Table 13.1B)

| Level | Raw Value | Score Range | Description |
|---|---|---|---|
| M1 | `healthy` | 58–65 | Healthy/optimal mental functioning |
| M2 | `neuroticGood` | 51–57 | Good functioning with some difficulties |
| M3 | `neuroticMild` | 42–50 | Mild impairments |
| M4 | `borderlineModerate` | 36–41 | Moderate impairments |
| M5 | `borderlineMajor` | 22–35 | Significant impairments |
| M6 | `borderlineSignificant` | 21–27 | Major deficits in basic functioning |
| M7 | `psychotic` | 13–20 | Severe deficits |

> **Note:** Score ranges 22–27 currently overlap between M5 and M6. The `switch` hits M5 first — review intended ranges.

---

## Diagnostic Engine

```swift
func suggestPersonalityStyles(from mAxis: MAxisScores) -> [PrototypeMatch]
```

1. Takes the patient's 13-value profile as a `[Double]`.
2. Computes **Euclidean distance** to each `PersonalityStyle.typicalMAxisProfile`.
3. Converts distance to a 0–100 match score (`max(0, 100 - distance/maxDistance*100)`).
4. Returns the **top 5** matches sorted by score descending.

`typicalMAxisProfile` is a hand-coded `[Double]` (13 values) per personality style, representing the approximate M Axis profile typical of that style per PDM-3 research.

---

## Personality Styles (P Axis — 13 Styles)

| Style | Raw Value |
|---|---|
| `narcissistic` | נרקיסיסטי |
| `obsessiveCompulsive` | טורדני-כפייתי |
| `dependent` | תלותי |
| `paranoid` | פרנואידי |
| `psychopathic` | פסיכופתי |
| `histrionic` | היסטריוני |
| `avoidant` | נמנע (חרדתי) |
| `schizoid` | סכיזואידי |
| `depressive` | דכאוני |
| `masochistic` | מזוכיסטי |
| `emotionallyDysregulated` | דיסרגולציה רגשית |
| `sadistic` | סאדיסטי |
| `somatizing` | סומטיזציה |

Each style has:
- `description` — short summary (shown in diagnosis tab)
- `fullPrototypeText` — full PDM-3 empirical prototype (shown in `DisclosureGroup`)
- `typicalMAxisProfile` — `[Double]` (13 values) used by the diagnostic engine

> **Known gap:** `masochistic.fullPrototypeText` currently returns only `description` — the full prototype text is missing and should be added.

---

## Persistence

- **Location:** `~/Library/Application Support/diagnostic/data.json`
- **Format:** JSON array of `Patient` (Codable)
- **Write strategy:** Debounced saves (0.5s) for slider changes via `debouncedSave()`; immediate save for structural changes (add/delete/rename)
- **Atomic writes:** `.atomic` option on `Data.write(to:options:)` prevents partial writes

---

## UI Layout

```
NavigationSplitView
├── Sidebar
│   ├── "ניווט בספר PDM-3" button → BookBrowserView
│   ├── Patient list (sorted by insertion, newest first)
│   └── Add patient form (TextField + Button)
└── Detail
    ├── BookBrowserView (when PDM-3 book browser selected)
    ├── PatientDetailView (when patient selected)
    │   ├── Header: name TextField + delete button
    │   └── TabView
    │       ├── Tab 0 "הערכה": mental functioning level card + 13 sliders
    │       ├── Tab 1 "סיכום": readable clinical summary text
    │       └── Tab 2 "אבחנה": top-5 P Axis matches + level card
    └── ContentUnavailableView (when nothing selected)
```

The entire app uses `environment(\.layoutDirection, .rightToLeft)` for RTL Hebrew layout.

---

## Key Conventions

### Slider Binding Pattern
All sliders clamp values to 1.0–5.0:
```swift
private func mAxisBinding(for keyPath: WritableKeyPath<MAxisScores, Double>) -> Binding<Double> {
    Binding(
        get: { workingMAxis[keyPath: keyPath] },
        set: { newValue in
            var v = newValue.clamped(to: 1...5)
            workingMAxis[keyPath: keyPath] = v
        }
    )
}
```

### State Update Flow
```
User moves slider
  → workingMAxis updated (local @State)
    → .onChange(of: workingMAxis) fires
      → store.updateMAxisScores(_:) called
        → patients[idx].mAxisScores updated
          → debouncedSave() schedules write
```

### Adding a New Personality Style
1. Add case to `PersonalityStyle` enum
2. Add `description` in `var description: String`
3. Add `fullPrototypeText` in `var fullPrototypeText: String`
4. Add `typicalMAxisProfile: [Double]` (must be exactly 13 values)
5. No other changes needed — `CaseIterable` auto-includes it in the engine

### Adding a New M Axis Capacity
1. Add `var capacityN_Name: Double = 3` to `MAxisScores`
2. Add to `asArray` (order matters — keep consistent with `mAxisScaleDefs`)
3. Add `MAxisScaleDefinition` entry to `mAxisScaleDefs` in same position
4. Update all `typicalMAxisProfile` arrays in `PersonalityStyle` to add the new value

---

## Code to Remove (Legacy — Not Used)

The following legacy code exists for backward compatibility with an old 5-axis system. It can be safely deleted once confirmed no old saved data exists:

| Symbol | File location | Reason to remove |
|---|---|---|
| `struct AxisScores` | Models section | Replaced by `MAxisScores` |
| `AxisScores.toMAxis()` | Models section | Migration only |
| `Patient.migrateToMAxis()` | Patient extension | Migration only |
| `private let scaleDefs` | Metadata section | Replaced by `mAxisScaleDefs` |
| `struct SliderRow` | UI Components | Identical duplicate of `MAxisSliderRow` |
| `struct RadarChart` / `PolygonShape` / `RadarShape` | UI Components | Defined but not used |
| `suggestPrototypes(from:)` | Diagnostic Engine | Legacy wrapper — unused |
| `Patient.scores: AxisScores` field | Patient struct | Old field |
| `LocalStore.updateScores(_:)` | LocalStore | Updates unused field |
| `workingScores: AxisScores` state | PatientDetailView | Not displayed or used |
| `func binding(for:)` (AxisScores variant) | PatientDetailView | No callers |
| `func normalized(_:)` | PatientDetailView | No callers |
| `.onChange(of: workingScores)` | PatientDetailView | Writes to unused field |

---

## Known Issues to Fix

1. **`masochistic.fullPrototypeText` is missing** — returns only `description`. Add the full PDM-3 Box 12.x text.

2. **`MentalFunctioningLevel` score ranges overlap:**
   ```swift
   case 22...35: return .borderlineMajor        // M5
   case 21...27: return .borderlineSignificant  // M6 — overlaps 22–27 with M5
   ```
   Clarify the intended boundary between M5 and M6 per PDM-3 Table 13.1B.

3. **`RadarChart` hardcoded to 5 axes** — the shape logic uses `sides: 5` and `count=5`. If repurposed for the 13-axis M Axis, it needs to be generalized.
