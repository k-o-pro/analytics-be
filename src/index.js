// Import required modules
import { Router } from 'itty-router';
import jwt from '@tsndr/cloudflare-worker-jwt';
import { createCors } from 'itty-cors';

// Import route handlers
import { handleAuth, handleLogin, handleCallback, refreshToken, handleRegister, checkSystem, createTestUser, checkUser } from './auth';
import { fetchGSCData, getProperties, getTopPages } from './gsc';
import { generateInsights, generatePageInsights } from './insights';
import { getCredits, useCredits } from './credits';

// Helper function to execute SQL safely
async function executeSql(db, sql) {
  try {
    await db.prepare(sql).run();
    return { success: true };
  } catch (error) {
    console.error(`SQL execution error: ${error.message}`);
    console.error(`SQL was: ${sql}`);
    return { success: false, error };
  }
}

// Initialize database function - ensure tables exist
async function initializeDatabase(env) {
  try {
    if (!env.DB) {
      console.error("Database binding is missing");
      return { success: false, error: new Error("Database binding is missing") };
    }

    console.log("Starting database initialization");
    
    // User table
    const userTableResult = await executeSql(env.DB, `CREATE TABLE IF NOT EXISTS users (
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
    
    if (!userTableResult.success) {
      console.error("Failed to create users table:", userTableResult.error);
      return { success: false, error: userTableResult.error };
    }
    
    // GSC data table
    const gscTableResult = await executeSql(env.DB, `CREATE TABLE IF NOT EXISTS gsc_data (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      site_url TEXT NOT NULL,
      date_range TEXT NOT NULL,
      dimensions TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);
    
    if (!gscTableResult.success) {
      console.error("Failed to create gsc_data table:", gscTableResult.error);
      return { success: false, error: gscTableResult.error };
    }

    // Insights table
    const insightsTableResult = await executeSql(env.DB, `CREATE TABLE IF NOT EXISTS insights (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      site_url TEXT NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);
    
    if (!insightsTableResult.success) {
      console.error("Failed to create insights table:", insightsTableResult.error);
      return { success: false, error: insightsTableResult.error };
    }

    // Credit logs table
    const creditLogsTableResult = await executeSql(env.DB, `CREATE TABLE IF NOT EXISTS credit_logs (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);
    
    if (!creditLogsTableResult.success) {
      console.error("Failed to create credit_logs table:", creditLogsTableResult.error);
      return { success: false, error: creditLogsTableResult.error };
    }

    // User properties table
    const userPropertiesTableResult = await executeSql(env.DB, `CREATE TABLE IF NOT EXISTS user_properties (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      site_url TEXT NOT NULL,
      display_name TEXT,
      added_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);
    
    if (!userPropertiesTableResult.success) {
      console.error("Failed to create user_properties table:", userPropertiesTableResult.error);
      return { success: false, error: userPropertiesTableResult.error };
    }

    // Indexes
    await executeSql(env.DB, `CREATE INDEX IF NOT EXISTS idx_gsc_data_user_site ON gsc_data (user_id, site_url)`);
    await executeSql(env.DB, `CREATE INDEX IF NOT EXISTS idx_insights_user_date ON insights (user_id, date)`);
    await executeSql(env.DB, `CREATE INDEX IF NOT EXISTS idx_credit_logs_user ON credit_logs (user_id)`);
    
    console.log("Database schema initialized successfully");
    return { success: true };
  } catch (error) {
    console.error("Error initializing database schema:", error);
    return { success: false, error };
  }
}

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

// Set up CORS
const { preflight, corsify } = createCors({
  origins: ['*'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  }
});

// Create router
const router = Router();

// System status endpoint - no auth required
router.get('/system/status', checkSystem);
router.get('/system/create-test-user', createTestUser);
router.get('/system/check-user', checkUser);

// Define auth routes
router.post('/auth/register', handleRegister);
router.post('/auth/login', handleLogin);
router.post('/auth/callback', handleCallback);
router.post('/auth/refresh', refreshToken);

// Define API routes
router.get('/gsc/properties', getProperties);
router.post('/gsc/data', fetchGSCData);
router.get('/gsc/top-pages', getTopPages);

// Define API routes for insights
router.post('/insights/generate', generateInsights);
router.post('/insights/page/:path', generatePageInsights);

// Define credit routes
router.get('/credits', getCredits);
router.post('/credits/use', useCredits);

// Root path for health check
router.get('/', (request, env) => {
  return new Response(JSON.stringify({
    status: 'ok',
    message: 'API server is running',
    version: '1.0.0'
  }), {
    status: 200,
    headers: { 
      'Content-Type': 'application/json'
    }
  });
});

// Not found handler for unmatched routes
router.all('*', (request) => {
  return new Response(JSON.stringify({
    success: false,
    error: 'Not found',
    path: new URL(request.url).pathname
  }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' }
  });
});

export default {
  async fetch(request, env, ctx) {
    try {
      // Initialize database (only on first request or monthly)
      await initializeDatabase(env);
      
      // Check for required environment variables
      const requiredVars = ['JWT_SECRET', 'PASSWORD_SALT', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
      const missingVars = requiredVars.filter(v => !env[v]);
      
      if (missingVars.length > 0) {
        console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Server configuration error',
          message: 'The server is missing required configuration.'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Handle CORS preflight requests
      if (request.method === 'OPTIONS') {
        return preflight(request);
      }
      
      // Get the path for easier access
      const url = new URL(request.url);
      const path = url.pathname;
      
      // Authentication check for protected routes
      let user = null;
      if (path !== '/auth/register' && path !== '/auth/login' && path !== '/') {
        const authHeader = request.headers.get('Authorization');
        if (authHeader && authHeader.startsWith('Bearer ')) {
          const token = authHeader.split(' ')[1];
          try {
            const verified = await jwt.verify(token, env.JWT_SECRET);
            if (verified) {
              user = verified.payload;
              // Attach user to request object
              request.user = user;
            }
          } catch (error) {
            console.error('JWT verification error:', error);
          }
        }
        
        // Return unauthorized if not authenticated for protected routes
        if (!user && path !== '/auth/callback' && 
            !path.startsWith('/system/')) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Unauthorized',
            message: 'Authentication required'
          }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // Route the request through the router
      const response = await router.handle(request, env);
      
      // Apply CORS headers to all responses
      return corsify(response);
    } catch (error) {
      console.error('Unhandled exception:', error);
      
      // Return a generic error response
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Server error: ' + error.message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  },
  // Handle scheduled tasks
  async scheduled(event, env, ctx) {
    try {
      // Initialize database 
      const initResult = await initializeDatabase(env);
      
      if (!initResult.success) {
        console.error("Failed to initialize database for scheduled task:", initResult.error);
        return;
      }
      
      // Add scheduled tasks here
      console.log("Running scheduled task at", event.cron);
    } catch (error) {
      console.error("Error in scheduled task:", error);
    }
  }
};