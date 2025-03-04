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

// Create router
const router = Router();

// Create CORS handler with appropriate origins
const { preflight, corsify } = createCors({
  origins: ['https://analytics.k-o.pro', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowCredentials: true,
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
        return new Response(JSON.stringify({
          error: "Server configuration error",
          message: `The server is missing required configuration: ${missingVars.join(', ')}`
        }), {
          status: 500,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Credentials': 'true'
          }
        });
      }
      
      // Initialize database before handling any request
      const initResult = await initializeDatabase(env);
      
      if (!initResult.success) {
        console.error("Failed to initialize database:", initResult.error);
        return new Response(JSON.stringify({
          error: "Database initialization error",
          message: initResult.error.message
        }), {
          status: 500,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Credentials': 'true'
          }
        });
      }
      
      // Handle OPTIONS requests directly for CORS
      if (request.method === 'OPTIONS') {
        return new Response(null, { 
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Max-Age': '86400'
          }
        });
      }
      
      // Handle the request with a promise timeout to prevent hanging
      const routerPromise = router.handle(request, env, ctx);
      
      // Set a timeout to ensure we don't hang indefinitely
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Request timeout - router did not respond in time'));
        }, 5000); // 5 second timeout
      });
      
      // Race between router and timeout
      const response = await Promise.race([routerPromise, timeoutPromise])
        .catch(error => {
          console.error("Router error:", error);
          return new Response(JSON.stringify({
            error: "Route processing error",
            message: error.message
          }), {
            status: 500,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
              'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization',
              'Access-Control-Allow-Credentials': 'true'
            }
          });
        });
      
      // If no response was generated, create a default one
      if (!response) {
        console.error("No response was generated by the router");
        return new Response(JSON.stringify({
          error: "Route handler did not generate a response"
        }), {
          status: 500,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Credentials': 'true'
          }
        });
      }
      
      // Ensure the response has the correct CORS headers
      const newResponse = new Response(response.body, response);
      
      // Add CORS headers to the response
      newResponse.headers.set('Access-Control-Allow-Origin', 'https://analytics.k-o.pro');
      newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      newResponse.headers.set('Access-Control-Allow-Credentials', 'true');
      
      return newResponse;
    } catch (error) {
      console.error("Server error:", error);
      return new Response(JSON.stringify({ 
        error: "Internal server error", 
        message: error.message,
        stack: error.stack
      }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true'
        }
      });
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