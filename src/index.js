import { Router } from 'itty-router';
import { createCors } from 'itty-cors';

// Import route handlers
import { handleAuth, handleLogin, handleCallback, refreshToken } from './auth';
import { fetchGSCData, getProperties, getTopPages } from './gsc';
import { generateInsights, generatePageInsights } from './insights';
import { getCredits, useCredits } from './credits';

// Create CORS handler
const { preflight, corsify } = createCors({
  origins: [ENV.FRONTEND_URL],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  maxAge: 86400,
});

// Create router
const router = Router();

// CORS preflight
router.all('*', preflight);

// Auth routes
router.post('/auth/login', handleLogin);
router.post('/auth/callback', handleCallback);
router.post('/auth/refresh', refreshToken);

// GSC data routes
router.get('/gsc/properties', handleAuth, getProperties);
router.post('/gsc/data', handleAuth, fetchGSCData);
router.get('/gsc/top-pages', handleAuth, getTopPages);

// Analytics & insights routes
router.post('/insights/generate', handleAuth, generateInsights);
router.post('/insights/page/:url', handleAuth, generatePageInsights);

// Credits management
router.get('/credits', handleAuth, getCredits);
router.post('/credits/use', handleAuth, useCredits);

// 404 handler
router.all('*', () => new Response('Not Found', { status: 404 }));

// Export Worker
export default {
  // Handle fetch events
  async fetch(request, env, ctx) {
    return router.handle(request).then(corsify);
  },

  // Handle scheduled tasks
  async scheduled(event, env, ctx) {
    // Refresh GSC data for all active users
    const { results } = await env.DB.prepare(
      'SELECT id, gsc_refresh_token FROM users WHERE gsc_connected = 1'
    ).all();
    
    for (const user of results) {
      try {
        // Refresh token and fetch latest data
        await refreshUserGSCData(user.id, user.gsc_refresh_token);
      } catch (error) {
        console.error(`Failed to refresh data for user ${user.id}:`, error);
      }
    }
  }
};