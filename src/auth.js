import { verify, sign } from '@tsndr/cloudflare-worker-jwt';

// Web Crypto API for hashing
function sha256Hash(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return crypto.subtle.digest('SHA-256', data)
    .then(buffer => {
      return Array.from(new Uint8Array(buffer))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
    });
}

// Handle authentication middleware
export async function handleAuth(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Unauthorized', { status: 401 });
    }
    
    const token = authHeader.split(' ')[1];
    const verified = await verify(token, env.JWT_SECRET);
    
    if (!verified) {
      return new Response('Invalid token', { status: 403 });
    }
    
    // Add user info to request for downstream handlers
    request.user = verified.payload;
    
    // Continue to next handler
    return null;
  } catch (error) {
    return new Response('Authentication error', { status: 403 });
  }
}

// Handle registration
// Function to create test data if needed
export async function createTestUser(request) {
  const env = request.env;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true'
  };
  
  // Only allow this in development mode
  if (env.NODE_ENV !== 'development') {
    return new Response(JSON.stringify({
      success: false,
      error: 'This endpoint is only available in development mode'
    }), {
      status: 403,
      headers
    });
  }
  
  try {
    // Create a test user
    const email = 'test@example.com';
    const password = 'password123';
    const salt = env.PASSWORD_SALT || 'test-salt';
    
    // Hash the password
    const hash = await sha256Hash(password + salt);
    
    // Try to delete existing test user first
    try {
      await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email).run();
    } catch (deleteError) {
      console.log('Error deleting existing test user:', deleteError);
    }
    
    // Create the user
    await env.DB.prepare(
      'INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, datetime())'
    ).bind('Test User', email, hash).run();
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Test user created',
      credentials: {
        email,
        password: 'password123'
      }
    }), {
      status: 200,
      headers
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers
    });
  }
}

// Diagnostic function to check system health
export async function checkUser(request) {
  const env = request.env;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true'
  };
  
  try {
    // Get email from query params
    const url = new URL(request.url);
    const email = url.searchParams.get('email');
    
    if (!email) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Email parameter is required'
      }), {
        status: 400,
        headers
      });
    }
    
    // Check if this email exists in the database
    const user = await env.DB.prepare(
      'SELECT id, email, password_hash, created_at FROM users WHERE email = ?'
    ).bind(email).first();
    
    if (!user) {
      return new Response(JSON.stringify({
        success: false,
        message: 'User not found'
      }), {
        status: 404,
        headers
      });
    }
    
    // User found, return info (excluding sensitive parts of hash)
    return new Response(JSON.stringify({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
        has_password: !!user.password_hash,
        password_hash_sample: user.password_hash ? 
          `${user.password_hash.substring(0, 6)}...${user.password_hash.substring(user.password_hash.length - 6)}` : null
      }
    }), {
      status: 200,
      headers
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers
    });
  }
}

export async function checkSystem(request) {
  const env = request.env;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true'
  };
  
  try {
    // Check environment variables
    const envStatus = {
      jwt_secret: !!env.JWT_SECRET,
      password_salt: !!env.PASSWORD_SALT,
      db_binding: !!env.DB,
      kv_binding: !!env.AUTH_STORE,
      frontend_url: env.FRONTEND_URL || 'https://analytics.k-o.pro'
    };
    
    // Test database connection
    let dbStatus = { connected: false, error: null };
    
    if (env.DB) {
      try {
        const result = await env.DB.prepare('SELECT 1 as test').first();
        dbStatus.connected = !!result?.test;
        dbStatus.test_result = result;
        
        // Count users
        const userCount = await env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
        dbStatus.user_count = userCount?.count || 0;
      } catch (dbError) {
        dbStatus.error = dbError.message;
      }
    }
    
    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      environment: envStatus,
      database: dbStatus
    }), {
      status: 200,
      headers
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers
    });
  }
}

export async function handleRegister(request, env) {
  // Basic headers for all responses
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true'
  };

  try {
    // Parse the request
    const { name, email, password } = await request.json();
    
    // Basic validation
    if (!email || !password) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Email and password are required' 
        }), 
        { status: 400, headers }
      );
    }
    
    // Check for required environment variables
    if (!env.PASSWORD_SALT) {
      console.error('Missing PASSWORD_SALT environment variable');
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Server configuration error'
        }),
        { status: 500, headers }
      );
    }
    
    try {
      // Hash the password
      const salt = env.PASSWORD_SALT;
      const hash = await sha256Hash(password + salt);
      
      // Create the user in the database
      await env.DB.prepare(
        'INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, datetime())'
      ).bind(name || 'User', email, hash).run();
      
      return new Response(
        JSON.stringify({ 
          success: true,
          message: 'Registration successful' 
        }), 
        { status: 201, headers }
      );
    } catch (dbError) {
      // Check for unique constraint violation (email already exists)
      if (dbError.message && dbError.message.includes('UNIQUE constraint failed')) {
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: 'Email already registered' 
          }), 
          { status: 409, headers }
        );
      }
      
      console.error('Database error:', dbError);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Registration failed: Database error' 
        }), 
        { status: 500, headers }
      );
    }
  } catch (error) {
    console.error('Registration error:', error);
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: 'Registration error: ' + error.message 
      }), 
      { status: 500, headers }
    );
  }
}

// Add CORS headers to all responses
const getCorsHeaders = () => ({
  'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Max-Age': '86400',
});

// Handle OPTIONS requests for CORS preflight
async function handleOptions() {
  return new Response(null, {
    headers: getCorsHeaders()
  });
}

// Handle login
export async function handleLogin(request) {
  const env = request.env;
  const headers = {
    'Content-Type': 'application/json',
    ...getCorsHeaders()
  };

  try {
    // Handle OPTIONS request
    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    console.log('Login request received:', request.url);
    
    let email, password;
    try {
      const data = await request.json();
      email = data.email;
      password = data.password;
      
      if (!email || !password) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Email and password are required'
        }), { status: 400, headers });
      }

      if (!env.JWT_SECRET || !env.PASSWORD_SALT) {
        console.error('Missing environment variables:', {
          hasJwtSecret: !!env.JWT_SECRET,
          hasPasswordSalt: !!env.PASSWORD_SALT
        });
        
        // List all available env vars (safe ones)
        console.log('Available environment variables:', Object.keys(env).filter(key => 
          !key.toLowerCase().includes('secret') && 
          !key.toLowerCase().includes('password') && 
          !key.toLowerCase().includes('token')
        ));
        
        return new Response(JSON.stringify({
          success: false,
          error: 'Server configuration error'
        }), { status: 500, headers });
      }
      
      // Log for debugging
      console.log('Environment variables check passed:', {
        hasJwtSecret: !!env.JWT_SECRET,
        hasPasswordSalt: !!env.PASSWORD_SALT,
        jwtSecretLength: env.JWT_SECRET ? env.JWT_SECRET.length : 0,
        saltLength: env.PASSWORD_SALT ? env.PASSWORD_SALT.length : 0
      });
    } catch (parseError) {
      console.error('Failed to parse request JSON:', parseError);
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid request format'
      }), { status: 400, headers });
    }
    
    // Query the database for user
    try {
      console.log('Querying database for user email:', email);
      
      // Check if DB is available
      if (!env.DB) {
        console.error('Database not available in environment');
        return new Response(JSON.stringify({
          success: false,
          error: 'Database configuration error'
        }), { status: 500, headers });
      }
      
      try {
        // Test DB connection with a simple query first
        const testResult = await env.DB.prepare('SELECT 1 as test').first();
        console.log('Database test query result:', testResult);
      } catch (testError) {
        console.error('Database connection test failed:', testError);
        return new Response(JSON.stringify({
          success: false,
          error: 'Database connection error'
        }), { status: 500, headers });
      }
      
      const user = await env.DB.prepare(
        'SELECT id, email, password_hash FROM users WHERE email = ?'
      ).bind(email).first();

      console.log('Database query complete. User found:', !!user);
      
      if (!user) {
        console.log('User not found:', email);
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid email or password'
        }), { status: 401, headers });
      }
      
      console.log('User details retrieved:', {
        id: user.id,
        email: user.email,
        has_password: !!user.password_hash
      });

      // Verify password
      try {
        const passwordValid = await verifyPassword(password, user.password_hash, env.PASSWORD_SALT);
        
        if (!passwordValid) {
          console.log('Invalid password for user:', email);
          return new Response(JSON.stringify({
            success: false,
            error: 'Invalid credentials'
          }), { status: 401, headers });
        }
        
        // Generate JWT token
        const token = await sign({
          user_id: user.id,
          email: user.email
        }, env.JWT_SECRET, { expiresIn: '24h' });
        
        // Update last login timestamp
        await env.DB.prepare(
          'UPDATE users SET last_login = datetime() WHERE id = ?'
        ).bind(user.id).run();
        
        console.log('Login successful for user:', email);
        return new Response(JSON.stringify({ 
          success: true,
          token 
        }), { status: 200, headers });
      } catch (passwordError) {
        console.error('Password verification error:', passwordError);
        return new Response(JSON.stringify({
          success: false,
          error: 'Authentication error'
        }), { status: 500, headers });
      }
    } catch (dbError) {
      console.error('Database error during login:', dbError);
      return new Response(JSON.stringify({
        success: false,
        error: 'Database error during login'
      }), { status: 500, headers });
    }
  } catch (error) {
    console.error('Login error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Login failed: ' + error.message
    }), { status: 500, headers });
  }
}

// Handle OAuth callback
export async function handleCallback(request, env) {
  try {
    const { code, state } = await request.json();
    
    // Headers for the response with CORS
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true'
    };
    
    // Log request details for debugging
    console.log('OAuth callback request received:');
    console.log('- Authorization header:', request.headers.get('Authorization') ? 'Present' : 'Missing');
    console.log('- Has code:', code ? 'Yes' : 'No');
    console.log('- Has state:', state ? 'Yes' : 'No');
    
    // Validate required parameters
    if (!code) {
      console.error('Missing authorization code in request');
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing authorization code'
      }), { status: 400, headers });
    }
    
    // Log OAuth debug information
    console.log('Processing OAuth callback, code received, exchanging for token');
    console.log('Redirect URI:', `${env.FRONTEND_URL}/oauth-callback`);
    
    // Check if user is authenticated
    if (!request.user || !request.user.user_id) {
      console.error('User not authenticated in OAuth callback');
      return new Response(JSON.stringify({
        success: false,
        error: 'Authentication required to connect Google Search Console',
        authRequired: true
      }), { status: 401, headers });
    }
    
    console.log(`User authenticated with ID: ${request.user.user_id}`);
    
    // Exchange code for tokens
    try {
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${env.FRONTEND_URL}/oauth-callback`,
          grant_type: 'authorization_code'
        })
      });
      
      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error('OAuth token exchange error:', errorText);
        return new Response(JSON.stringify({
          success: false,
          error: `OAuth error: ${errorText}`
        }), { status: 400, headers });
      }
      
      const tokenData = await tokenResponse.json();
      const { access_token, refresh_token, expires_in } = tokenData;
      
      console.log('Token exchange successful:');
      console.log('- Has access token:', !!access_token);
      console.log('- Has refresh token:', !!refresh_token);
      console.log('- Expires in:', expires_in);
      
      if (!refresh_token) {
        console.error('No refresh token returned from Google OAuth');
        // If we received an access token but no refresh token, it might be because
        // the user previously granted permission to the same app
        if (access_token) {
          console.log('Access token received without refresh token, checking if we already have a refresh token');
          
          // Check if we already have a refresh token for this user
          const user = await env.DB.prepare(
            'SELECT gsc_refresh_token FROM users WHERE id = ?'
          ).bind(request.user.user_id).first();
          
          if (user && user.gsc_refresh_token) {
            console.log('Using existing refresh token');
            
            // Store new access token in KV with expiration
            await env.AUTH_STORE.put(
              `gsc_token:${request.user.user_id}`, 
              access_token, 
              { expirationTtl: expires_in }
            );
            
            // Update the connected status
            await env.DB.prepare(
              'UPDATE users SET gsc_connected = 1 WHERE id = ?'
            ).bind(request.user.user_id).run();
            
            return new Response(JSON.stringify({ 
              success: true,
              message: 'Successfully connected to Google Search Console' 
            }), { status: 200, headers });
          }
        }
        
        return new Response(JSON.stringify({
          success: false,
          error: 'No refresh token received from Google. Please revoke access and try again.'
        }), { status: 400, headers });
      }
      
      // Store refresh token in database (linked to user)
      const userId = request.user.user_id;
      console.log(`Updating GSC connection for user ID: ${userId}`);
      
      try {
        await env.DB.prepare(
          'UPDATE users SET gsc_refresh_token = ?, gsc_connected = 1 WHERE id = ?'
        ).bind(refresh_token, userId).run();
        
        // Store access token in KV with expiration
        await env.AUTH_STORE.put(
          `gsc_token:${userId}`, 
          access_token, 
          { expirationTtl: expires_in }
        );
        
        console.log(`Successfully connected GSC for user ID: ${userId}`);
        
        return new Response(JSON.stringify({ 
          success: true,
          message: 'Successfully connected to Google Search Console' 
        }), { status: 200, headers });
      } catch (dbError) {
        console.error('Database error during GSC connection:', dbError);
        return new Response(JSON.stringify({
          success: false,
          error: 'Failed to store GSC connection information'
        }), { status: 500, headers });
      }
    } catch (tokenError) {
      console.error('Error during token exchange:', tokenError);
      return new Response(JSON.stringify({
        success: false,
        error: 'Token exchange error: ' + tokenError.message
      }), { status: 500, headers });
    }
  } catch (error) {
    console.error('OAuth callback error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'OAuth callback failed: ' + error.message 
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
}

// Refresh GSC token
export async function refreshToken(request, env) {
  const userId = request.user.user_id;
  console.log(`Refreshing GSC token for user ${userId}`);
  
  // Define common headers including CORS
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': env.FRONTEND_URL || 'https://analytics.k-o.pro',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true'
  };
  
  // Get refresh token from database
  const user = await env.DB.prepare(
    'SELECT gsc_refresh_token, email FROM users WHERE id = ?'
  ).bind(userId).first();
  
  if (!user || !user.gsc_refresh_token) {
    console.error(`No refresh token found for user ${userId}`);
    
    // Update the connected status to false
    if (user) {
      console.log(`Marking user ${userId} as GSC disconnected due to missing refresh token`);
      await env.DB.prepare(
        'UPDATE users SET gsc_connected = 0 WHERE id = ?'
      ).bind(userId).run();
    }
    
    return new Response(JSON.stringify({
      success: false,
      error: 'No refresh token found',
      needsConnection: true
    }), { 
      status: 400,
      headers: headers
    });
  }
  
  console.log(`Found refresh token for user ${userId} (${user.email}), exchanging for access token`);
  
  // Exchange refresh token for new access token
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: user.gsc_refresh_token,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token'
      })
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error(`Token refresh failed for user ${userId}: ${errorText}`);
      
      // If refresh fails, prompt user to reconnect
      console.log(`Marking user ${userId} as GSC disconnected due to token refresh failure`);
      await env.DB.prepare(
        'UPDATE users SET gsc_connected = 0 WHERE id = ?'
      ).bind(userId).run();
      
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to refresh token: ${errorText}`,
        needsConnection: true
      }), { 
        status: 401,
        headers: headers
      });
    }
    
    const tokenData = await tokenResponse.json();
    const { access_token, expires_in } = tokenData;
    
    console.log(`Token refreshed successfully for user ${userId}, expires in ${expires_in} seconds`);
    
    // Store new access token in KV
    await env.AUTH_STORE.put(
      `gsc_token:${userId}`, 
      access_token, 
      { expirationTtl: expires_in }
    );
    
    // Make sure the connected flag is set to true
    await env.DB.prepare(
      'UPDATE users SET gsc_connected = 1 WHERE id = ?'
    ).bind(userId).run();
    
    return new Response(JSON.stringify({ 
      success: true,
      message: 'Token refreshed successfully' 
    }), {
      headers: headers
    });
  } catch (error) {
    console.error(`Error refreshing token for user ${userId}:`, error);
    return new Response(JSON.stringify({
      success: false,
      error: `Error refreshing token: ${error.message}`
    }), { 
      status: 500,
      headers: headers
    });
  }
}

// Password verification function (simple SHA-256 hash with salt)
// Note: For production, consider using a more robust password hashing method like bcrypt
async function verifyPassword(password, storedHash, salt) {
  console.log('Verifying password:');
  console.log('- Password provided:', !!password);
  console.log('- Stored hash available:', !!storedHash);
  console.log('- Salt available:', !!salt);
  
  // Create a SHA-256 hash of the password with salt
  const hash = await sha256Hash(password + salt);
  
  console.log('- Generated hash:', hash ? hash.substring(0, 6) + '...' : 'null');
  console.log('- Stored hash:', storedHash ? storedHash.substring(0, 6) + '...' : 'null');
  console.log('- Hashes match:', hash === storedHash);
  
  // Compare hashes
  return hash === storedHash;
}