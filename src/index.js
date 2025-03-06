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

// Create CORS handlers
const { preflight, corsify } = createCors({
  origins: ['https://analytics.k-o.pro'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  headers: {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
});

// Initialize router with CORS
const router = Router();

// Add CORS preflight handler for all routes
router.options('*', (request) => {
  const origin = request.headers.get('Origin') || '';
  if (origin.match(/\.k-o\.pro$/)) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      }
    });
  }
  return new Response(null, { status: 204 });
});

// Define auth routes first
router.post('/auth/register', (request, env) => handleRegister(request, env));
router.post('/auth/login', (request, env) => handleLogin(request, env));
router.post('/auth/callback', (request, env) => handleCallback(request, env));
router.post('/auth/refresh', (request, env) => refreshToken(request, env));

// Define other routes
router.post('/gsc/data', (request, env) => fetchGSCData(request, env));
router.get('/gsc/properties', (request, env) => getProperties(request, env));
router.get('/gsc/top-pages', (request, env) => getTopPages(request, env));

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
    
    // Very simple router implementation
    const url = new URL(request.url);
    const path = url.pathname;
    
    try {
      // Initialize database on every request
      await initializeDatabase(env);

      // Handle OPTIONS requests
      if (request.method === 'OPTIONS') {
        return preflight(request);
      }

      // Handle the request with router and wrap response with CORS
      const response = await router.handle(request, env);
      if (!response) {
        return corsify(new Response(JSON.stringify({
          success: false,
          error: 'Not Found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      // Add CORS headers to response
      return corsify(response);

    } catch (error) {
      console.error('Unhandled exception:', error);
      return corsify(new Response(
        JSON.stringify({
          success: false,
          error: 'Server error: ' + error.message,
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      ));
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