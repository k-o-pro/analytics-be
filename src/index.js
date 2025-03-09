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

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Name-Version',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    try {
      // Handle CORS preflight requests
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders,
            'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers'),
          }
        });
      }

      // Very simple router implementation
      const url = new URL(request.url);
      const path = url.pathname;
      
      try {
        // Initialize database on every request
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
            headers: { 
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
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
          if (!user && path !== '/auth/callback') {
            return new Response(JSON.stringify({
              success: false,
              error: 'Unauthorized',
              message: 'Authentication required'
            }), {
              status: 401,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }
        }
        
        // Add CORS headers to every response
        const createResponse = (body, status = 200) => {
          return new Response(JSON.stringify(body), {
            status,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        };

        // Direct path matching for key endpoints
        if (path === '/auth/register' && request.method === 'POST') {
          const response = await handleRegister(request, env);
          // Add CORS headers to the response
          Object.keys(corsHeaders).forEach(key => {
            response.headers.set(key, corsHeaders[key]);
          });
          return response;
        }
        
        if (path === '/auth/login' && request.method === 'POST') {
          const response = await handleLogin(request, env);
          // Add CORS headers to the response
          Object.keys(corsHeaders).forEach(key => {
            response.headers.set(key, corsHeaders[key]);
          });
          return response;
        }
        
        if (path === '/auth/callback' && request.method === 'POST') {
          const response = await handleCallback(request, env);
          // Add CORS headers to the response
          Object.keys(corsHeaders).forEach(key => {
            response.headers.set(key, corsHeaders[key]);
          });
          return response;
        }
        
        if (path === '/auth/refresh' && request.method === 'POST') {
          const response = await refreshToken(request, env);
          // Add CORS headers to the response
          Object.keys(corsHeaders).forEach(key => {
            response.headers.set(key, corsHeaders[key]);
          });
          return response;
        }
        
        // GSC data routes
        if (path === '/gsc/properties' && request.method === 'GET') {
          const response = await getProperties(request, env);
          // Add CORS headers to the response
          Object.keys(corsHeaders).forEach(key => {
            response.headers.set(key, corsHeaders[key]);
          });
          return response;
        }
        
        if (path === '/gsc/data' && request.method === 'POST') {
          const response = await fetchGSCData(request, env);
          // Add CORS headers to the response
          Object.keys(corsHeaders).forEach(key => {
            response.headers.set(key, corsHeaders[key]);
          });
          return response;
        }
        
        if (path === '/gsc/top-pages' && request.method === 'GET') {
          const response = await getTopPages(request, env);
          // Add CORS headers to the response
          Object.keys(corsHeaders).forEach(key => {
            response.headers.set(key, corsHeaders[key]);
          });
          return response;
        }
        
        // Analytics & insights routes
        if (path === '/insights/generate' && request.method === 'POST') {
          const response = await generateInsights(request, env);
          // Add CORS headers to the response
          Object.keys(corsHeaders).forEach(key => {
            response.headers.set(key, corsHeaders[key]);
          });
          return response;
        }
        
        if (path.startsWith('/insights/page/') && request.method === 'POST') {
          const response = await generatePageInsights(request, env);
          // Add CORS headers to the response
          Object.keys(corsHeaders).forEach(key => {
            response.headers.set(key, corsHeaders[key]);
          });
          return response;
        }
        
        // Credits management
        if (path === '/credits' && request.method === 'GET') {
          const response = await getCredits(request, env);
          // Add CORS headers to the response
          Object.keys(corsHeaders).forEach(key => {
            response.headers.set(key, corsHeaders[key]);
          });
          return response;
        }
        
        if (path === '/credits/use' && request.method === 'POST') {
          const response = await useCredits(request, env);
          // Add CORS headers to the response
          Object.keys(corsHeaders).forEach(key => {
            response.headers.set(key, corsHeaders[key]);
          });
          return response;
        }
        
        // Root path for health check
        if (path === '/' && request.method === 'GET') {
          return new Response(JSON.stringify({
            status: 'ok',
            message: 'API server is running',
            version: '1.0.0'
          }), {
            status: 200,
            headers: { 
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
        
        // If no route matches
        return createResponse({
          success: false,
          error: 'Not found',
          path: path
        }, 404);

      } catch (error) {
        console.error('Unhandled exception:', error);
        return createResponse({
          success: false,
          error: 'Server error: ' + error.message,
        }, 500);
      }
    } catch (error) {
      return createResponse({
        success: false,
        error: error.message
      }, 500);
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