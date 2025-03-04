// Import required modules
import { Router } from 'itty-router';
import jwt from '@tsndr/cloudflare-worker-jwt';
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

export default {
  async fetch(request, env, ctx) {
    // Define common headers for CORS support
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.FRONTEND_URL || 'https://analytics.k-o.pro',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
    };

    // Handle preflight OPTIONS request
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Create a response promise that will be resolved by the router
    // or by the timeout handler
    let responseResolve;
    const responsePromise = new Promise(resolve => {
      responseResolve = resolve;
    });

    // Set a timeout for the request
    const timeoutId = setTimeout(() => {
      responseResolve(
        new Response(
          JSON.stringify({
            success: false,
            error: 'Request processing timeout',
          }),
          {
            status: 504,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders,
            },
          }
        )
      );
    }, 25000); // 25 second timeout - adjusted from 30 for Cloudflare's limits

    // Initialize database and process the request
    try {
      const db = env.DB;
      
      // Check if DB is available before proceeding
      if (!db) {
        clearTimeout(timeoutId);
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Database unavailable',
          }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders,
            },
          }
        );
      }
      
      const url = new URL(request.url);
      const path = url.pathname;

      // Initialize the router
      const router = Router();
      
      // Auth routes
      router.post('/auth/register', async (req) => await handleRegister(req, env));
      router.post('/auth/login', async (req) => await handleLogin(req, env));
      router.post('/auth/callback', async (req) => await handleCallback(req, env));
      router.post('/auth/refresh', async (req) => await refreshToken(req, env));

      // GSC data routes
      router.get('/gsc/properties', async (req) => {
        const authResult = await handleAuth(req, env);
        if (authResult.status !== 200) return authResult;
        return await getProperties(req, env);
      });
      
      router.post('/gsc/data', async (req) => {
        const authResult = await handleAuth(req, env);
        if (authResult.status !== 200) return authResult;
        return await fetchGSCData(req, env);
      });
      
      router.get('/gsc/top-pages', async (req) => {
        const authResult = await handleAuth(req, env);
        if (authResult.status !== 200) return authResult;
        return await getTopPages(req, env);
      });

      // Analytics & insights routes
      router.post('/insights/generate', async (req) => {
        const authResult = await handleAuth(req, env);
        if (authResult.status !== 200) return authResult;
        return await generateInsights(req, env);
      });
      
      router.post('/insights/page/:url', async (req) => {
        const authResult = await handleAuth(req, env);
        if (authResult.status !== 200) return authResult;
        return await generatePageInsights(req, env);
      });

      // Credits management
      router.get('/credits', async (req) => {
        const authResult = await handleAuth(req, env);
        if (authResult.status !== 200) return authResult;
        return await getCredits(req, env);
      });
      
      router.post('/credits/use', async (req) => {
        const authResult = await handleAuth(req, env);
        if (authResult.status !== 200) return authResult;
        return await useCredits(req, env);
      });
      
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
      
      // 404 handler for all other routes
      router.all('*', () => new Response(JSON.stringify({
        error: 'Not Found',
        message: 'The requested resource does not exist'
      }), { 
        status: 404, 
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders 
        }
      }));

      // Handle the request with the router and resolve the response promise
      router.handle(request).then(response => {
        clearTimeout(timeoutId);
        responseResolve(response);
      }).catch(error => {
        console.error('Router error:', error);
        clearTimeout(timeoutId);
        responseResolve(
          new Response(
            JSON.stringify({
              success: false,
              error: 'Router error: ' + error.message,
            }),
            {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders,
              },
            }
          )
        );
      });

      // Wait for either the router to resolve or the timeout to fire
      return await responsePromise;
    } catch (error) {
      // Clear the timeout to prevent memory leaks
      clearTimeout(timeoutId);
      
      console.error('Unhandled exception:', error);
      
      // Return a generic error response
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Server error: ' + error.message,
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
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
      
      // Example: Refresh GSC data for all users
      // Implementation depends on your specific requirements
    } catch (error) {
      console.error("Error in scheduled task:", error);
    }
  }
};