// Functions to interact with Google Search Console API

// Get user's GSC properties
export async function getProperties(request, env) {
  const userId = request.user.user_id;
  
  // Get access token from KV
  let accessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
  
  if (!accessToken) {
      // Token expired, try to refresh
      const refreshResult = await refreshToken(request, env);
      if (!refreshResult.ok) {
          return refreshResult;
      }
      // Get new access token
      const newAccessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
      
      // Validate new token exists
      if (!newAccessToken) {
          return new Response('Failed to refresh access token', { 
              status: 401,
              headers: { 'Content-Type': 'application/json' }
          });
      }
      
      accessToken = newAccessToken;
  }
  
  // Fetch GSC properties
  const response = await fetch(
      'https://www.googleapis.com/webmasters/v3/sites',
      {
          headers: {
              'Authorization': `Bearer ${accessToken}`
          }
      }
  );
  
  if (!response.ok) {
      return new Response('Failed to fetch properties', { status: response.status });
  }
  
  const data = await response.json();
  return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' }
  });
}

// Fetch GSC data for specified property
export async function fetchGSCData(request, env) {
  const userId = request.user.user_id;
  const { siteUrl, startDate, endDate, dimensions = ['query', 'page'] } = await request.json();
  
  // Get access token from KV
  let accessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
  
  if (!accessToken) {
      // Token expired, try to refresh
      const refreshResult = await refreshToken(request, env);
      if (!refreshResult.ok) {
          return refreshResult;
      }
      // Get new access token
      const newAccessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
      
      // Validate new token exists
      if (!newAccessToken) {
          return new Response('Failed to refresh access token', { 
              status: 401,
              headers: { 'Content-Type': 'application/json' }
          });
      }
      
      accessToken = newAccessToken;
  }
  
  // Query Search Console API
  const response = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
          method: 'POST',
          headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
          },
          body: JSON.stringify({
              startDate,
              endDate,
              dimensions,
              rowLimit: 500
          })
      }
  );
  
  if (!response.ok) {
      return new Response('Failed to fetch GSC data', { status: response.status });
  }
  
  const data = await response.json();
  
  // Store data in database for historical tracking
  const timestamp = new Date().toISOString();
  const dataJson = JSON.stringify(data);
  
  await env.DB.prepare(
      `INSERT INTO gsc_data (user_id, site_url, date_range, dimensions, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
      userId,
      siteUrl,
      `${startDate} to ${endDate}`,
      dimensions.join(','),
      dataJson,
      timestamp
  ).run();
  
  return new Response(dataJson, {
      headers: { 'Content-Type': 'application/json' }
  });
}

// Get top pages
export async function getTopPages(request, env) {
  const userId = request.user.user_id;
  const url = new URL(request.url);
  const siteUrl = url.searchParams.get('siteUrl');
  const startDate = url.searchParams.get('startDate');
  const endDate = url.searchParams.get('endDate');
  
  // Check if user has enough credits for more than 10 pages
  const user = await env.DB.prepare(
      'SELECT credits FROM users WHERE id = ?'
  ).bind(userId).first();
  
  // Default page limit
  let pageLimit = 10;
  
  // If analyzing more than 10 pages, check credits
  if (url.searchParams.get('limit') && parseInt(url.searchParams.get('limit')) > 10) {
      const requestedLimit = parseInt(url.searchParams.get('limit'));
      
      if (user.credits > 0) {
          // Allow up to 50 pages with credits
          pageLimit = Math.min(requestedLimit, 50);
          
          // Deduct credit if using more than default limit
          if (pageLimit > 10) {
              await env.DB.prepare(
                  'UPDATE users SET credits = credits - 1 WHERE id = ?'
              ).bind(userId).run();
          }
      }
  }
  
  // Get access token from KV (added token refresh logic)
  let accessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
  
  if (!accessToken) {
      const refreshResult = await refreshToken(request, env);
      if (!refreshResult.ok) {
          return refreshResult;
      }
      const newAccessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
      if (!newAccessToken) {
          return new Response('Failed to refresh access token', { 
              status: 401,
              headers: { 'Content-Type': 'application/json' }
          });
      }
      accessToken = newAccessToken;
  }
  
  // Query Search Console API for pages data
  const response = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
          method: 'POST',
          headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
          },
          body: JSON.stringify({
              startDate,
              endDate,
              dimensions: ['page'],
              rowLimit: pageLimit
          })
      }
  );
  
  if (!response.ok) {
      return new Response('Failed to fetch top pages', { status: response.status });
  }
  
  const data = await response.json();
  
  const result = {
      pages: data.rows || [],
      limit: pageLimit,
      creditsRemaining: user.credits - (pageLimit > 10 ? 1 : 0)
  };
  
  return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
  });
}