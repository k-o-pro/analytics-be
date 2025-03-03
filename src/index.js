import { Router } from 'itty-router';
import { createCors } from 'itty-cors';

// Import route handlers
import { handleAuth, handleLogin, handleCallback, refreshToken, handleRegister } from './auth';
import { fetchGSCData, getProperties, getTopPages } from './gsc';
import { generateInsights, generatePageInsights } from './insights';
import { getCredits, useCredits } from './credits';

// Helper function to execute SQL safely
async function executeSql(db, sql) {
  try {
    await db.prepare(sql).run();
    return true;
  } catch (error) {
    console.error(`SQL execution error: ${error.message}`);
    console.error(`SQL was: ${sql}`);
    return false;
  }
}

// Initialize database function - ensure tables exist
async function initializeDatabase(env) {
  try {
    // User table
    await executeSql(env.DB, `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      created_at TEXT NOT NULL,
      last_login TEXT,
      credits INTEGER DEFAULT 5,
      gsc_refresh_token TEXT,
      gsc_connected INTEGER DEFAULT 0
    )`);
    
    // GSC data table
    await executeSql(env.DB, `CREATE TABLE IF NOT EXISTS gsc_data (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      site_url TEXT NOT NULL,
      date_range TEXT NOT NULL,
      dimensions TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Insights table
    await executeSql(env.DB, `CREATE TABLE IF NOT EXISTS insights (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      site_url TEXT NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Credit logs table
    await executeSql(env.DB, `CREATE TABLE IF NOT EXISTS credit_logs (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // User properties table
    await executeSql(env.DB, `CREATE TABLE IF NOT EXISTS user_properties (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      site_url TEXT NOT NULL,
      display_name TEXT,
      added_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Indexes
    await executeSql(env.DB, `CREATE INDEX IF NOT EXISTS idx_gsc_data_user_site ON gsc_data (user_id, site_url)`);
    await executeSql(env.DB, `CREATE INDEX IF NOT EXISTS idx_insights_user_date ON insights (user_id, date)`);
    await executeSql(env.DB, `CREATE INDEX IF NOT EXISTS idx_credit_logs_user ON credit_logs (user_id)`);
    
    console.log("Database schema initialized successfully");
  } catch (error) {
    console.error("Error initializing database schema:", error);
  }
}

// Create router
const router = Router();

// Create CORS handler with appropriate origins
const { preflight, corsify } = createCors({
  origins: ['*'], // Allow all origins for now to troubleshoot
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization']
});

// Handle CORS preflight requests
router.options('*', preflight);

// Root route - API health check
router.get('/', () => {
  return new Response(JSON.stringify({
    status: 'ok',
    message: 'API server is running',
    version: '1.0.0'
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
});

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
router.all('*', () => new Response(JSON.stringify({
  error: 'Not Found',
  message: 'The requested resource does not exist'
}), { 
  status: 404, 
  headers: { 'Content-Type': 'application/json' }
}));

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
      // Check if all required environment variables are present
      const requiredVars = ['JWT_SECRET', 'PASSWORD_SALT', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
      const missingVars = requiredVars.filter(v => !env[v]);
      
      if (missingVars.length > 0) {
        console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
        return corsify(new Response(JSON.stringify({
          error: "Server configuration error",
          message: "The server is missing required configuration. Please contact the administrator."
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
      
      // Initialize database before handling any request
      await initializeDatabase(env);
      
      // Handle OPTIONS requests directly for CORS
      if (request.method === 'OPTIONS') {
        return corsify(new Response(null, { status: 204 }));
      }
      
      // Handle the request
      const response = await router.handle(request, env, ctx);
      
      // If no response was generated, create a default one
      if (!response) {
        console.error("No response was generated by the router");
        return corsify(new Response(JSON.stringify({
          error: "Route handler did not generate a response"
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
      
      return corsify(response);
    } catch (error) {
      console.error("Server error:", error);
      return corsify(new Response(JSON.stringify({ 
        error: "Internal server error", 
        message: error.message,
        stack: error.stack
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