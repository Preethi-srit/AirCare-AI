# AirCare AI — Intelligent Family Air Quality Companion

**Tagline:** *Breathe Smarter. Live Healthier. Protect Tomorrow.*

AirCare AI is a full-stack GenAI-powered environmental intelligence web application built to help families and communities navigate severe winter smog and urban air pollution through personalized exposure protection, indoor air quality guidance, sustainable daily routines, and transparent greenhouse gas impact analysis.

---

## 1. Problem Statement & Chosen Solution

### Problem Statement
Severe winter smog and urban particulate pollution expose households—especially children, elderly adults, students, and outdoor workers—to hazardous PM2.5 and PM10 levels both outdoors and inside poorly sealed homes. Families often receive raw AQI numbers without actionable guidance tailored to their living conditions, occupation, commute, or budget.

### Chosen Solution
AirCare AI bridges atmospheric monitoring with practical family decision-making:
- **Live & Honest AQI Monitoring:** Integrates real-time atmospheric data (Open-Meteo Copernicus CAMS, with optional WAQI station token), plus manual observed entry and clearly labelled winter smog demonstration scenarios when offline.
- **8-Step Gemini Recommendation Engine:** Evaluates household profile, current AQI, exposure risks, and lifestyle constraints to produce prioritized recommendations with transparent reasoning traces and feedback regeneration.
- **Morning-to-Night Routine Planner:** Organizes daily air-safe actions into Morning, Afternoon, Evening, and Night checklists without inventing unverified safe outdoor clock windows.
- **Indoor Air Quality Advisor & Green Lifestyle Assistant:** Delivers practical, income-inclusive actions across home types (apartment, house, hostel, shared accommodation, office) and sustainable mobility/household/community habits.
- **Documented Impact Calculator:** Quantifies monthly and annual CO2e changes across travel modes using published passenger-km emission factors while clearly distinguishing greenhouse gases from localized PM2.5/NOx.
- **Multilingual AirCare Assistant:** Session-aware Gemini chatbot supporting English, Tamil, and Hindi with optional profile context sharing.

---

## 2. Technology Stack

- **Frontend:** React 19, TypeScript, Vite 8, Tailwind CSS v4, Lucide Icons, custom responsive SVG data visualizations
- **Backend:** Node.js, Express 4, TypeScript (`tsx`), file-backed atomic JSON persistence (`.data/aircare-db.json`)
- **GenAI Integration:** `@google/genai` SDK running strictly server-side with `gemini-4-hydrogen` (with automatic transient-503 failover to `gemini-3.1-flash-lite` and per-request timeout guards), structured JSON schemas (`Type`), and transparent error reporting
- **Air Quality Upstream:** Keyless Open-Meteo Geocoding + Copernicus CAMS Air Quality API (by city name or GPS coordinates, plus optional `WAQI_API_TOKEN`)
- **Testing:** Node native test runner (`node --experimental-strip-types --test`)

---

## 3. Architecture & File Structure

```
/
├── server.ts                  # Express server, API routes, Vite dev middleware & static prod serving
├── server/
│   ├── auth.ts                # scrypt password hashing, HMAC-SHA256 tokens, HttpOnly/Bearer auth
│   ├── store.ts               # Atomic file-backed persistence + ephemeral in-memory guest sessions
│   ├── aqiService.ts          # City & coordinate live AQI upstream integration + unavailable-data handling
│   ├── geminiService.ts       # Server-side @google/genai integration (recommendations, routines, chat)
│   └── fallbackRules.ts       # Localized deterministic non-AI rule-based fallback clearly labelled in UI
├── shared/
│   ├── types.ts               # Shared domain interfaces across backend & frontend
│   ├── i18n.ts                # Multilingual UI translations (English, Tamil, Hindi)
│   ├── aqiUtils.ts            # US AQI band classification, demo scenarios, alert threshold logic
│   ├── emissions.ts           # Documented DEFRA/IPCC CO2e calculation engine (vehicle + fuel aware)
│   └── validation.ts          # Input validation and profile sanitization
├── src/
│   ├── App.tsx                # Application routing (Landing -> Auth -> Onboarding -> Workspace)
│   ├── services/apiClient.ts  # Typed fetch client holding Bearer token in memory
│   └── components/
│       ├── LandingPage.tsx
│       ├── AuthView.tsx
│       ├── OnboardingWizard.tsx
│       ├── WorkspaceLayout.tsx # Responsive 12-section sidebar navigation + header language switcher
│       ├── ui/                 # SVG charts & AQI source transparency banner
│       └── views/              # 12 dedicated functional workspace views
└── tests/
    └── core.test.ts           # 7 functional unit tests (emissions, alerts, i18n, fallback rules, validation)
```

---

## 4. AI Decision-Making Approach (8-Step Workflow)

The Family Safety engine follows an explicit 8-step pipeline:
1. **Understand User Profile:** Reads household composition (children, adults, elderly), occupation, home type, air purifier availability, commute distance, and optional respiratory sensitivity note.
2. **Obtain Available AQI Data:** Inspects verified live, manual, or clearly labelled demonstration AQI, PM2.5, PM10, and hourly trajectory.
3. **Identify Exposure Risks:** Flags high-risk conditions (e.g., AQI ≥ 151, children’s outdoor play, open two-wheeler commuting, indoor combustion).
4. **Evaluate Family Needs & Lifestyle:** Weighs practical constraints (e.g., outdoor worker occupational exposure vs student transit).
5. **Compare Practical Alternatives:** Evaluates low-cost indoor protections (wet mopping, sealing drafts, zero-ozone HEPA) and realistic transport shifts.
6. **Prioritize Recommendations:** Enforces **health-protective actions before sustainability shifts** whenever pollution reaches Unhealthy or Severe thresholds.
7. **Explain Benefits & Assumptions:** Displays *Why Recommended*, *Expected Benefit*, *Relevant User Group*, and *Data Source / Assumption* for every card.
8. **Feedback & Regeneration:** Users mark suggestions as Helpful or Not Relevant, supply custom constraints, and regenerate recommendations.

---

## 5. Installation & Setup

### Prerequisites
- Node.js 22+
- npm

### Local Installation
```bash
npm install
cp .env.example .env
```

Add your server-side Gemini key in `.env` (or in AI Studio **Settings > Secrets**):
```env
GEMINI_API_KEY="your_gemini_api_key"
# Optional: WAQI_API_TOKEN="your_waqi_token"
```

### Run Development Server
```bash
npm run dev
```
The Express + Vite server runs on `http://localhost:3000`.

### Build & Run Production
```bash
npm run build
npm start
```

---

## 6. API Configuration

- **`GEMINI_API_KEY` (Required for AI features):** Accessed strictly in `server/geminiService.ts`. If omitted, the UI transparently reports the missing configuration and offers the deterministic rule-based fallback (`engineMode: "rule-based-fallback"`) rather than disguising static text as Gemini output.
- **Live AQI (`Open-Meteo` / `WAQI_API_TOKEN`):** Works out of the box using Open-Meteo Copernicus CAMS without extra keys. If `WAQI_API_TOKEN` is set in `.env`, WAQI monitoring stations are queried first. If offline or unreachable, AirCare AI displays an unavailable state and lets users switch to Manual Entry or clearly labelled Demonstration Mode.

---

## 7. Testing & Verification

Run the automated functional test suite:
```bash
npm test
```

Run TypeScript static type checking and production bundle build:
```bash
npm run lint
npm run build
```

---

## 8. Security & Privacy Considerations

- **Server-Side Secret Boundary:** `GEMINI_API_KEY` and `WAQI_API_TOKEN` remain exclusively on the Node server (`process.env`) and are never exposed in client bundles.
- **Password & Session Security:** Registered user passwords are salted (16-byte random salt) and hashed with Node `crypto.scryptSync`, verified via `crypto.timingSafeEqual`. Sessions use HMAC-SHA256 signed tokens held in React memory and `HttpOnly; Secure; SameSite=None; Partitioned` cookies with origin/custom-header verification on mutations.
- **Input Sanitization & Data Minimization:** All text inputs, emails, profile numbers, and manual AQI entries are validated and bounded on both client and server. Medical records are never required; respiratory sensitivity notes are strictly optional and non-diagnostic.
- **Assistant Privacy Control:** Users can toggle off profile context sharing with the AI Chat Assistant in both Chat and Settings.

---

## 9. Assumptions & Limitations

1. **Emission Factors:** The Impact Calculator uses published average passenger-km CO2e conversion factors (DEFRA / IPCC / India GHG Program). Actual emissions vary by vehicle maintenance, occupancy, driving speed, and regional electricity grid mix.
2. **CO2e vs Local Air Pollutants:** Greenhouse gas (CO2e) savings do not translate 1:1 into immediate ambient AQI drops for a single household; the calculator explicitly distinguishes global CO2e from street-level PM2.5/NOx.
3. **In-App Alert Evaluation:** Alerts are evaluated inside the application whenever AQI readings are fetched or updated; background push notifications/SMS require external notification infrastructure and are not claimed as active.
4. **Not Medical Advice:** All guidance is informational environmental protection only and never replaces professional clinical diagnosis or medical care.
5. **Storage:** Account records persist locally in `.data/aircare-db.json` for single-node deployments; multi-instance cloud scaling would migrate `server/store.ts` to a managed database.
