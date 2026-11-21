import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  buildDemoAqiReading,
  classifyAqi,
  DEMO_SCENARIOS,
  evaluateAqiAlerts,
} from './shared/aqiUtils.ts';
import { calculateTravelImpact, type ImpactCalculatorInput } from './shared/emissions.ts';
import type {
  AqiReading,
  FamilyProfile,
  HomeType,
  PreferredLanguage,
  RoutineTask,
} from './shared/types.ts';
import {
  sanitizeAlertPreferences,
  sanitizeFamilyProfile,
  sanitizeText,
  validateEmail,
  validateManualAqiInput,
} from './shared/validation.ts';
import { fetchLiveAirQuality, fetchLiveAirQualityByCoords } from './server/aqiService.ts';
import {
  clearSessionCookie,
  extractSessionFromRequest,
  hashPassword,
  requireAuth,
  setSessionCookie,
  signSessionToken,
  verifyPassword,
  type AuthenticatedRequest,
} from './server/auth.ts';
import {
  buildRuleBasedIndoorPlan,
  buildRuleBasedLifestylePlan,
  buildRuleBasedRecommendations,
  buildRuleBasedRoutine,
} from './server/fallbackRules.ts';
import {
  chatWithAirCareAssistant,
  GeminiServiceError,
  generateDailyRoutinePlan,
  generateGreenLifestylePlan,
  generateIndoorAirPlan,
  generateStructuredRecommendations,
} from './server/geminiService.ts';
import {
  createDefaultAlertPreferences,
  createDefaultChallenges,
  createUser,
  findUserByEmail,
  findUserById,
  getOrCreateGuestState,
  saveUserRoutineTasks,
  toPublicUser,
  updateGuestState,
  updateUser,
} from './server/store.ts';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '512kb' }));

  // Health & capability status (never exposes secrets)
  app.get('/api/health', (_req, res) => {
    const hasGemini = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY',
    );
    const hasWaqi = Boolean(process.env.WAQI_API_TOKEN?.trim());
    res.json({
      status: 'ok',
      geminiConfigured: hasGemini,
      liveAqiProvider: hasWaqi ? 'WAQI + Open-Meteo' : 'Open-Meteo Copernicus CAMS',
    });
  });

  // --- Authentication Routes ---
  app.post('/api/auth/register', (req, res) => {
    const email = validateEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email) {
      res.status(400).json({ error: 'Please provide a valid email address.' });
      return;
    }
    if (password.length < 8 || password.length > 128) {
      res.status(400).json({ error: 'Password must be between 8 and 128 characters.' });
      return;
    }
    if (findUserByEmail(email)) {
      res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
      return;
    }

    const { salt, hash } = hashPassword(password);
    const profile = sanitizeFamilyProfile(req.body?.profile ?? {});
    const user = createUser({
      id: `usr_${crypto.randomUUID()}`,
      email,
      passwordSalt: salt,
      passwordHash: hash,
      profile,
      alertPreferences: createDefaultAlertPreferences(),
      challenges: createDefaultChallenges(),
      routinePlan: null,
      recommendationFeedback: {},
      createdAt: new Date().toISOString(),
    });

    const token = signSessionToken({ userId: user.id, email: user.email, isGuest: false });
    setSessionCookie(res, token, req);
    res.status(201).json({
      token,
      user: toPublicUser(user),
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const email = validateEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }
    const user = findUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const token = signSessionToken({ userId: user.id, email: user.email, isGuest: false });
    setSessionCookie(res, token, req);
    res.json({
      token,
      user: toPublicUser(user),
    });
  });

  app.post('/api/auth/guest', (req, res) => {
    const profile = sanitizeFamilyProfile(req.body?.profile ?? {});
    const guestId = `guest_${crypto.randomUUID()}`;
    const guestState = getOrCreateGuestState(guestId, profile);
    const token = signSessionToken({ userId: guestId, email: 'guest-demo@local', isGuest: true });
    setSessionCookie(res, token, req);
    res.json({
      token,
      user: {
        id: guestId,
        email: 'guest-demo@local',
        isGuest: true,
        profile: guestState.profile,
        alertPreferences: guestState.alertPreferences,
        challenges: guestState.challenges,
      },
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res, req);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const session = extractSessionFromRequest(req);
    if (!session) {
      res.status(401).json({ error: 'No active session.' });
      return;
    }
    if (session.isGuest) {
      const guestState = getOrCreateGuestState(session.userId, sanitizeFamilyProfile({}));
      res.json({
        user: {
          id: session.userId,
          email: session.email,
          isGuest: true,
          profile: guestState.profile,
          alertPreferences: guestState.alertPreferences,
          challenges: guestState.challenges,
        },
      });
      return;
    }
    const user = findUserById(session.userId);
    if (!user) {
      res.status(401).json({ error: 'Account not found.' });
      return;
    }
    res.json({ user: toPublicUser(user) });
  });

  // --- Profile & Preferences Routes ---
  app.put('/api/profile', requireAuth, (req: AuthenticatedRequest, res) => {
    const session = req.session!;
    if (session.isGuest) {
      const base = getOrCreateGuestState(session.userId, sanitizeFamilyProfile({})).profile;
      const sanitized = sanitizeFamilyProfile(req.body ?? {}, base);
      updateGuestState(session.userId, (g) => ({ ...g, profile: sanitized }));
      res.json({ profile: sanitized, persistedToAccount: false });
      return;
    }
    const updated = updateUser(session.userId, (user) => ({
      ...user,
      profile: sanitizeFamilyProfile(req.body ?? {}, user.profile),
    }));
    if (!updated) {
      res.status(404).json({ error: 'User account not found.' });
      return;
    }
    res.json({ profile: updated.profile, persistedToAccount: true });
  });

  app.put('/api/alerts/preferences', requireAuth, (req: AuthenticatedRequest, res) => {
    const session = req.session!;
    if (session.isGuest) {
      const guest = getOrCreateGuestState(session.userId, sanitizeFamilyProfile({}));
      const nextPrefs = sanitizeAlertPreferences(req.body ?? {}, guest.alertPreferences);
      updateGuestState(session.userId, (g) => ({ ...g, alertPreferences: nextPrefs }));
      res.json({ alertPreferences: nextPrefs });
      return;
    }
    const updated = updateUser(session.userId, (user) => ({
      ...user,
      alertPreferences: sanitizeAlertPreferences(req.body ?? {}, user.alertPreferences),
    }));
    if (!updated) {
      res.status(404).json({ error: 'User account not found.' });
      return;
    }
    res.json({ alertPreferences: updated.alertPreferences });
  });

  app.post('/api/alerts/evaluate', requireAuth, (req: AuthenticatedRequest, res) => {
    const session = req.session!;
    const aqiReading = req.body?.aqiReading as AqiReading | undefined;
    const previousAqi =
      typeof req.body?.previousAqi === 'number' ? req.body.previousAqi : null;
    if (!aqiReading) {
      res.status(400).json({ error: 'aqiReading is required.' });
      return;
    }
    const user = session.isGuest ? null : findUserById(session.userId);
    const guest = session.isGuest
      ? getOrCreateGuestState(session.userId, sanitizeFamilyProfile({}))
      : null;
    const profile = user?.profile ?? guest?.profile ?? sanitizeFamilyProfile(req.body?.profile ?? {});
    const prefs =
      user?.alertPreferences ??
      guest?.alertPreferences ??
      sanitizeAlertPreferences(req.body?.alertPreferences ?? {});
    const alerts = evaluateAqiAlerts(aqiReading, previousAqi, prefs, profile);
    res.json({ alerts });
  });

  // --- Community Challenges ---
  app.post('/api/challenges/:challengeId/toggle', requireAuth, (req: AuthenticatedRequest, res) => {
    const session = req.session!;
    const { challengeId } = req.params;
    const action = req.body?.action === 'complete' ? 'complete' : 'join';
    if (session.isGuest) {
      const updatedGuest = updateGuestState(session.userId, (g) => ({
        ...g,
        challenges: g.challenges.map((c) => {
          if (c.id !== challengeId) return c;
          if (action === 'complete') {
            return {
              ...c,
              joined: true,
              completionsCount: c.completionsCount + 1,
              lastCompletedAt: new Date().toISOString(),
            };
          }
          return { ...c, joined: !c.joined };
        }),
      }));
      res.json({
        challenges: updatedGuest?.challenges,
        ok: true,
        persistedToAccount: false,
      });
      return;
    }
    const updated = updateUser(session.userId, (user) => ({
      ...user,
      challenges: user.challenges.map((c) => {
        if (c.id !== challengeId) return c;
        if (action === 'complete') {
          return {
            ...c,
            joined: true,
            completionsCount: c.completionsCount + 1,
            lastCompletedAt: new Date().toISOString(),
          };
        }
        return { ...c, joined: !c.joined };
      }),
    }));
    if (!updated) {
      res.status(404).json({ error: 'User account not found.' });
      return;
    }
    res.json({ challenges: updated.challenges, persistedToAccount: true });
  });

  // --- Air Quality Data Routes ---
  app.get('/api/aqi/live', async (req, res) => {
    if (typeof req.query.lat === 'string' && typeof req.query.lon === 'string') {
      const lat = Number(req.query.lat);
      const lon = Number(req.query.lon);
      const reading = await fetchLiveAirQualityByCoords(lat, lon);
      res.json(reading);
      return;
    }
    const city = typeof req.query.city === 'string' ? req.query.city : '';
    const reading = await fetchLiveAirQuality(city);
    res.json(reading);
  });

  app.get('/api/aqi/demo-scenarios', (_req, res) => {
    res.json({ scenarios: DEMO_SCENARIOS });
  });

  app.get('/api/aqi/demo/:scenarioId', (req, res) => {
    const reading = buildDemoAqiReading(req.params.scenarioId);
    res.json(reading);
  });

  app.post('/api/aqi/manual', (req, res) => {
    const check = validateManualAqiInput(req.body ?? {});
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
    const { city, aqi, pm25, pm10 } = check.data;
    const band = classifyAqi(aqi);
    const reading: AqiReading = {
      city,
      locationLabel: `${city} (Manual Entry)`,
      aqi,
      category: band.category,
      pm25,
      pm10,
      dominantPollutant: pm25 * 1.5 >= pm10 ? 'PM2.5' : 'PM10',
      sourceMode: 'manual',
      providerLabel: 'User-Entered Observed Reading',
      updatedAt: new Date().toISOString(),
      isDemo: false,
      disclaimer:
        'Manually entered AQI observation provided by the user. Verify against an official local monitoring station when possible.',
      hourlyTrend: [],
    };
    res.json(reading);
  });

  // --- Environmental Impact Calculator ---
  app.post('/api/impact/calculate', (req, res) => {
    const result = calculateTravelImpact(req.body as ImpactCalculatorInput);
    if (!result.valid) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  // --- Gemini AI Routes (Server-Side Only) ---
  app.post('/api/ai/recommendations', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const session = req.session!;
      const user = session.isGuest ? null : findUserById(session.userId);
      const profile: FamilyProfile = user?.profile
        ? sanitizeFamilyProfile(req.body?.profile ?? {}, user.profile)
        : sanitizeFamilyProfile(req.body?.profile ?? {});
      const aqiReading = req.body?.aqiReading as AqiReading | undefined;
      if (!aqiReading) {
        res.status(400).json({ error: 'aqiReading is required.' });
        return;
      }
      const useFallback = req.body?.useFallback === true;
      if (useFallback) {
        res.json(buildRuleBasedRecommendations(profile, aqiReading));
        return;
      }
      const feedbackNotes = Array.isArray(req.body?.feedbackNotes)
        ? req.body.feedbackNotes.map((n: unknown) => sanitizeText(n, 140)).filter(Boolean)
        : [];
      const result = await generateStructuredRecommendations(profile, aqiReading, feedbackNotes);
      res.json(result);
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: 'Unexpected error generating recommendations.' });
    }
  });

  app.post('/api/ai/recommendations/feedback', requireAuth, (req: AuthenticatedRequest, res) => {
    const session = req.session!;
    const recId = sanitizeText(req.body?.recommendationId, 80);
    const feedback = req.body?.feedback === 'helpful' ? 'helpful' : 'not_relevant';
    if (!recId) {
      res.status(400).json({ error: 'recommendationId is required.' });
      return;
    }
    if (!session.isGuest) {
      updateUser(session.userId, (user) => ({
        ...user,
        recommendationFeedback: { ...user.recommendationFeedback, [recId]: feedback },
      }));
    }
    res.json({ ok: true, recommendationId: recId, feedback });
  });

  app.get('/api/routine', requireAuth, (req: AuthenticatedRequest, res) => {
    const session = req.session!;
    if (session.isGuest) {
      const guest = getOrCreateGuestState(session.userId, sanitizeFamilyProfile({}));
      res.json({ plan: guest.routinePlan });
      return;
    }
    const user = findUserById(session.userId);
    res.json({ plan: user?.routinePlan ?? null });
  });

  app.put('/api/routine/tasks', requireAuth, (req: AuthenticatedRequest, res) => {
    const session = req.session!;
    const tasks = Array.isArray(req.body?.tasks) ? (req.body.tasks as RoutineTask[]) : null;
    if (!tasks) {
      res.status(400).json({ error: 'tasks array is required.' });
      return;
    }
    if (session.isGuest) {
      const updatedGuest = updateGuestState(session.userId, (g) => ({
        ...g,
        routinePlan: g.routinePlan ? { ...g.routinePlan, tasks } : null,
      }));
      res.json({ plan: updatedGuest?.routinePlan ?? null, ok: true, persistedToAccount: false });
      return;
    }
    const saved = saveUserRoutineTasks(session.userId, null, tasks);
    res.json({ plan: saved, persistedToAccount: true });
  });

  app.post('/api/ai/routine', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const session = req.session!;
      const user = session.isGuest ? null : findUserById(session.userId);
      const guest = session.isGuest
        ? getOrCreateGuestState(session.userId, sanitizeFamilyProfile({}))
        : null;
      const profile = user?.profile
        ? sanitizeFamilyProfile(req.body?.profile ?? {}, user.profile)
        : sanitizeFamilyProfile(req.body?.profile ?? {}, guest?.profile);
      const aqiReading = req.body?.aqiReading as AqiReading | undefined;
      if (!aqiReading) {
        res.status(400).json({ error: 'aqiReading is required.' });
        return;
      }
      const plan =
        req.body?.useFallback === true
          ? buildRuleBasedRoutine(profile, aqiReading)
          : await generateDailyRoutinePlan(profile, aqiReading);

      if (session.isGuest) {
        updateGuestState(session.userId, (g) => ({ ...g, routinePlan: plan }));
      } else {
        saveUserRoutineTasks(session.userId, plan);
      }
      res.json(plan);
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: 'Unexpected error generating daily routine.' });
    }
  });

  app.post('/api/ai/indoor-plan', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const session = req.session!;
      const user = session.isGuest ? null : findUserById(session.userId);
      const profile = user?.profile
        ? sanitizeFamilyProfile(req.body?.profile ?? {}, user.profile)
        : sanitizeFamilyProfile(req.body?.profile ?? {});
      const aqiReading = req.body?.aqiReading as AqiReading | undefined;
      if (!aqiReading) {
        res.status(400).json({ error: 'aqiReading is required.' });
        return;
      }
      const homeType = (req.body?.homeType as HomeType) || profile.homeType;
      const conditions = {
        hasPurifier: Boolean(req.body?.conditions?.hasPurifier ?? profile.hasAirPurifier),
        usesIncenseOrCandles: Boolean(req.body?.conditions?.usesIncenseOrCandles),
        indoorSmokingPresent: Boolean(req.body?.conditions?.indoorSmokingPresent),
        dampnessOrMould: Boolean(req.body?.conditions?.dampnessOrMould),
        nearBusyRoad: Boolean(req.body?.conditions?.nearBusyRoad),
      };

      const plan =
        req.body?.useFallback === true
          ? buildRuleBasedIndoorPlan(homeType, profile, aqiReading)
          : await generateIndoorAirPlan(profile, aqiReading, homeType, conditions);
      res.json(plan);
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: 'Unexpected error generating indoor air plan.' });
    }
  });

  app.post('/api/ai/lifestyle', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const session = req.session!;
      const user = session.isGuest ? null : findUserById(session.userId);
      const profile = user?.profile
        ? sanitizeFamilyProfile(req.body?.profile ?? {}, user.profile)
        : sanitizeFamilyProfile(req.body?.profile ?? {});
      const aqiReading = req.body?.aqiReading as AqiReading | undefined;
      if (!aqiReading) {
        res.status(400).json({ error: 'aqiReading is required.' });
        return;
      }
      const plan =
        req.body?.useFallback === true
          ? buildRuleBasedLifestylePlan(profile)
          : await generateGreenLifestylePlan(profile, aqiReading);
      res.json(plan);
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: 'Unexpected error generating green lifestyle plan.' });
    }
  });

  app.post('/api/ai/chat', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const session = req.session!;
      const user = session.isGuest ? null : findUserById(session.userId);
      const profile = user?.profile
        ? sanitizeFamilyProfile(req.body?.profile ?? {}, user.profile)
        : sanitizeFamilyProfile(req.body?.profile ?? {});
      const message = sanitizeText(req.body?.message, 800);
      if (!message) {
        res.status(400).json({ error: 'Please enter a message or question.' });
        return;
      }
      const aqiReading = req.body?.aqiReading as AqiReading | undefined;
      if (!aqiReading) {
        res.status(400).json({ error: 'aqiReading context is required.' });
        return;
      }
      const language: PreferredLanguage =
        req.body?.language === 'Tamil' || req.body?.language === 'Hindi'
          ? req.body.language
          : 'English';
      const shareProfile = req.body?.shareProfile !== false && profile.shareContextWithAssistant;
      const rawHistory: unknown[] = Array.isArray(req.body?.history)
        ? req.body.history
        : [];
      const history = rawHistory
        .filter(
          (m: unknown): m is { role: 'user' | 'assistant'; content: string } =>
            Boolean(m) &&
            typeof m === 'object' &&
            ((m as { role?: string }).role === 'user' ||
              (m as { role?: string }).role === 'assistant') &&
            typeof (m as { content?: string }).content === 'string',
        )
        .map((m: { role: 'user' | 'assistant'; content: string }) => ({
          role: m.role,
          content: sanitizeText(m.content, 1000),
        }));

      const result = await chatWithAirCareAssistant({
        message,
        history,
        profile,
        aqi: aqiReading,
        language,
        shareProfile,
      });

      res.json({
        ...result,
        usedProfileContext: shareProfile,
      });
    } catch (err) {
      if (err instanceof GeminiServiceError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: 'Unexpected error from AirCare Assistant.' });
    }
  });

  // --- Vite Dev / Static Production Serving ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AirCare AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
