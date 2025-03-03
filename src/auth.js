import { verify, sign } from '@tsndr/cloudflare-worker-jwt';
import { createHash } from 'crypto';

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
  try {
    const { name, email, password } = await request.json();
    
    // Content-Type header for all responses
    const headers = {
      'Content-Type': 'application/json'
    };

    // Validate required fields
    if (!email || !password) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Email and password are required' 
        }), 
        { status: 400, headers }
      );
    }

    const existingUser = await env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    ).bind(email).first();
    
    if (existingUser) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Email already registered' 
        }), 
        { status: 409, headers }
      );
    }
    
    // Hash password
    const salt = env.PASSWORD_SALT;
    const hash = createHash('sha256')
      .update(password + salt)
      .digest('hex');
    
    // Insert user with current timestamp
    const result = await env.DB.prepare(
      'INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, datetime())'
    ).bind(name, email, hash).run();
    
    return new Response(
      JSON.stringify({ 
        success: true,
        message: 'Registration successful' 
      }), 
      { status: 201, headers }
    );
  } catch (error) {
    console.error('Registration error:', error);
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: 'Registration failed: ' + error.message 
      }), 
      { 
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }
}

// Handle login
export async function handleLogin(request, env) {
  try {
    const { email, password } = await request.json();
    
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
        { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }
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
        { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    // Generate JWT token
    const token = await sign({
      user_id: user.id,
      email: user.email
    }, env.JWT_SECRET, { expiresIn: '24h' });
    
    return new Response(
      JSON.stringify({ 
        success: true,
        token 
      }), 
      {
        headers: { 'Content-Type': 'application/json' }
      }
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
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// Handle OAuth callback
export async function handleCallback(request, env) {
  const { code, state } = await request.json();
  
  // Validate state to prevent CSRF
  // In production, verify state matches a stored value
  
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
    const error = await tokenResponse.text();
    return new Response(`OAuth error: ${error}`, { status: 400 });
  }
  
  const { access_token, refresh_token, expires_in } = await tokenResponse.json();
  
  // Store refresh token in database (linked to user)
  const userId = request.user.user_id;
  await env.DB.prepare(
    'UPDATE users SET gsc_refresh_token = ?, gsc_connected = 1 WHERE id = ?'
  ).bind(refresh_token, userId).run();
  
  // Store access token in KV with expiration
  await env.AUTH_STORE.put(
    `gsc_token:${userId}`, 
    access_token, 
    { expirationTtl: expires_in }
  );
  
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
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
  const hash = createHash('sha256')
    .update(password + salt)
    .digest('hex');
  
  // Compare hashes
  return hash === storedHash;
}