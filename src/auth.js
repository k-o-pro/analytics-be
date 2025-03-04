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

// Handle login
export async function handleLogin(request, env) {
  try {
    const { email, password } = await request.json();
    
    // Content-Type header for all responses
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true'
    };
    
    // Check if JWT_SECRET and PASSWORD_SALT are defined
    if (!env.JWT_SECRET || !env.PASSWORD_SALT) {
      console.error('Missing JWT_SECRET or PASSWORD_SALT environment variables');
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Server configuration error'
        }),
        { status: 500, headers }
      );
    }
    
    // Query the database for user
    const user = await env.DB.prepare(
      'SELECT id, email, password_hash FROM users WHERE email = ?'
    ).bind(email).first();
    
    if (!user) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Invalid credentials'
        }), 
        { status: 401, headers }
      );
    }
    
    // Verify password (in production, use bcrypt or similar)
    const passwordValid = await verifyPassword(password, user.password_hash, env.PASSWORD_SALT);
    
    if (!passwordValid) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Invalid credentials'
        }), 
        { status: 401, headers }
      );
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
    
    return new Response(
      JSON.stringify({ 
        success: true,
        token 
      }), 
      { status: 200, headers }
    );
  } catch (error) {
    console.error('Login error:', error);
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: 'Login failed: ' + error.message 
      }), 
      { 
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true'
        }
      }
    );
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
    
    // Exchange code for tokens
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
    
    const { access_token, refresh_token, expires_in } = await tokenResponse.json();
    
    if (!refresh_token) {
      console.error('No refresh token returned from Google OAuth');
      return new Response(JSON.stringify({
        success: false,
        error: 'No refresh token received from Google'
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
  
  // Get refresh token from database
  const user = await env.DB.prepare(
    'SELECT gsc_refresh_token FROM users WHERE id = ?'
  ).bind(userId).first();
  
  if (!user || !user.gsc_refresh_token) {
    return new Response('No refresh token found', { status: 400 });
  }
  
  // Exchange refresh token for new access token
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
    // If refresh fails, prompt user to reconnect
    await env.DB.prepare(
      'UPDATE users SET gsc_connected = 0 WHERE id = ?'
    ).bind(userId).run();
    
    return new Response('Failed to refresh token', { status: 401 });
  }
  
  const { access_token, expires_in } = await tokenResponse.json();
  
  // Store new access token in KV
  await env.AUTH_STORE.put(
    `gsc_token:${userId}`, 
    access_token, 
    { expirationTtl: expires_in }
  );
  
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// Password verification function (simple SHA-256 hash with salt)
// Note: For production, consider using a more robust password hashing method like bcrypt
async function verifyPassword(password, storedHash, salt) {
  // Create a SHA-256 hash of the password with salt
  const hash = await sha256Hash(password + salt);
  
  // Compare hashes
  return hash === storedHash;
}