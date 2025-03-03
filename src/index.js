import { Router } from 'itty-router';
import { createCors } from 'itty-cors';

// Import route handlers
import { handleAuth, handleLogin, handleCallback, refreshToken, handleRegister } from './auth';
import { fetchGSCData, getProperties, getTopPages } from './gsc';
import { generateInsights, generatePageInsights } from './insights';
import { getCredits, useCredits } from './credits';

// Create router
const router = Router();

// Create CORS handler with appropriate origins
const { preflight, corsify } = createCors({
  origins: ['https://analytics.k-o.pro', 'http://localhost:3000'], // Added localhost for development
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],  // Added OPTIONS explicitly
  maxAge: 86400,
  credentials: true,
});

// CORS preflight - this handles OPTIONS requests
router.options('*', preflight);  // Changed from router.all to router.options for preflight
router.all('*', preflight);      // Keep this for backward compatibility

// Register routes - note that all routes need to be processed by the router
router.post('/auth/register', handleRegister);
router.post('/auth/login', handleLogin);
router.post('/auth/callback', handleAuth, handleCallback);
router.post('/auth/refresh', handleAuth, refreshToken);

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
}

export default {
  fetch: async (request, env, ctx) => {
    try {
      // Important: Always wrap the router.handle with corsify
      return corsify(await router.handle(request, env, ctx));
    } catch (error) {
      // Add error handling to ensure we always return a response
      console.error("Error processing request:", error);
      return corsify(new Response(JSON.stringify({ 
        error: "Internal server error", 
        message: error.message 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }));
    }
  },

  // Handle scheduled tasks
  async scheduled(event, env, ctx) {
    // Refresh GSC data for all active users
    const { results } = await env.DB.prepare(
      'SELECT id, gsc_refresh_token FROM users WHERE gsc_connected = 1'
    ).all();
    
    for (const user of results) {
      try {
        await refreshUserGSCData(user.id, user.gsc_refresh_token, env);
      } catch (error) {
        console.error(`Failed to refresh data for user ${user.id}:`, error);
      }
    }
  }
};