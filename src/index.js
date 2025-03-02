import { Router } from 'itty-router';
import { createCors } from 'itty-cors';

// Import route handlers
import { handleAuth, handleLogin, handleCallback, refreshToken } from './auth';
import { fetchGSCData, getProperties, getTopPages } from './gsc';
import { generateInsights, generatePageInsights } from './insights';
import { getCredits, useCredits } from './credits';

// Create CORS handler
const { preflight, corsify } = createCors({
  origins: [env => env.FRONTEND_URL],
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
// Function to refresh GSC data for a user
async function refreshUserGSCData(userId, refreshToken, env) {
  // Exchange refresh token for new access token
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  });
  
  if (!tokenResponse.ok) {
    throw new Error('Failed to refresh token');
  }
  
  const { access_token, expires_in } = await tokenResponse.json();
  
  // Store new access token in KV
  await env.AUTH_STORE.put(
    `gsc_token:${userId}`, 
    access_token, 
    { expirationTtl: expires_in }
  );
  
  // Fetch latest GSC data and store in database
  // This would call your fetchGSCData function with necessary parameters
  // Implementation depends on your specific data needs
}

export default {
  // Handle fetch events
  async fetch(request, env, ctx) {
    return router.handle(request, env, ctx).then(corsify);
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
        await refreshUserGSCData(user.id, user.gsc_refresh_token, env);
      } catch (error) {
        console.error(`Failed to refresh data for user ${user.id}:`, error);
      }
    }
  }
};