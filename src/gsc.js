// Functions to interact with Google Search Console API
import { refreshToken } from './auth.js';
import { Router } from 'itty-router';

const router = Router();

// Define common headers for reuse
export const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true'
};

// Handle OPTIONS requests
router.options('*', () => {
    return new Response(null, {
        status: 204,
        headers: corsHeaders
    });
});

// Get user's GSC properties
export async function getProperties(request, env) {
  const userId = request.user.user_id;
  
  console.log(`Getting GSC properties for user ${userId}`);
  
  // Check if user has connected GSC
  const user = await env.DB.prepare(
      'SELECT gsc_connected, gsc_refresh_token FROM users WHERE id = ?'
  ).bind(userId).first();
  
  if (!user || !user.gsc_connected || !user.gsc_refresh_token) {
      console.log(`User ${userId} has not connected GSC yet:`, {
          hasUser: !!user,
          connected: user?.gsc_connected,
          hasRefreshToken: !!user?.gsc_refresh_token
      });
      
      return new Response(JSON.stringify({
          success: false,
          error: 'Google Search Console not connected',
          needsConnection: true
      }), { 
          status: 400,
          headers: corsHeaders
      });
  }
  
  // Get access token from KV
  let accessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
  console.log(`Access token for user ${userId}: ${accessToken ? 'Present' : 'Missing'}`);
  
  if (!accessToken) {
      console.log(`Access token not found for user ${userId}, refreshing...`);
      // Token expired, try to refresh
      const refreshResult = await refreshToken(request, env);
      if (!refreshResult.ok) {
          console.error(`Failed to refresh token for user ${userId}:`, refreshResult.statusText);
          return refreshResult;
      }
      
      // Get new access token
      const newAccessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
      
      // Validate new token exists
      if (!newAccessToken) {
          console.error(`Failed to get new access token for user ${userId} after refresh`);
          return new Response(JSON.stringify({
              success: false,
              error: 'Failed to refresh access token',
              needsConnection: true
          }), { 
              status: 401,
              headers: corsHeaders
          });
      }
      
      console.log(`Token refreshed successfully for user ${userId}`);
      accessToken = newAccessToken;
  }
  
  // Fetch GSC properties
  console.log(`Fetching GSC properties for user ${userId}`);
  try {
      const response = await fetch(
          'https://www.googleapis.com/webmasters/v3/sites',
          {
              headers: {
                  'Authorization': `Bearer ${accessToken}`
              }
          }
      );
      
      if (!response.ok) {
          const errorText = await response.text();
          console.error(`GSC API error (${response.status}):`, errorText);
          
          // If unauthorized, token might be invalid, try refreshing
          if (response.status === 401) {
              console.log('Token seems invalid, trying to refresh...');
              await env.AUTH_STORE.delete(`gsc_token:${userId}`);
              return getProperties(request, env); // Retry once with a fresh token
          }
          
          return new Response(JSON.stringify({
              success: false,
              error: `Failed to fetch properties: ${errorText}`,
              status: response.status
          }), { 
              status: response.status,
              headers: corsHeaders
          });
      }
      
      const data = await response.json();
      console.log(`Successfully fetched ${data.siteEntry?.length || 0} GSC properties for user ${userId}`);
      
      return new Response(JSON.stringify({
          success: true,
          ...data
      }), {
          headers: corsHeaders
      });
  } catch (error) {
      console.error(`Error fetching GSC properties for user ${userId}:`, error);
      return new Response(JSON.stringify({
          success: false,
          error: `Failed to fetch properties: ${error.message}`
      }), { 
          status: 500,
          headers: corsHeaders
      });
  }
}

// Fetch GSC data for specified property
export async function fetchGSCData(request, env) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': env.FRONTEND_URL || 'https://analytics.k-o.pro',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true'
  };

  try {
    const userId = request.user.user_id;
    const { siteUrl, startDate, endDate, dimensions = ['date'] } = await request.json();
    
    console.log('Fetching GSC data:', { userId, siteUrl, startDate, endDate, dimensions });

  // Get user's refresh token
  const user = await env.DB.prepare(
    'SELECT gsc_refresh_token FROM users WHERE id = ?'
  ).bind(userId).first();

  if (!user?.gsc_refresh_token) {
    return new Response(JSON.stringify({
      error: 'Google Search Console not connected'
    }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Get access token using refresh token
  const accessToken = await refreshToken(request, env);
  if (!accessToken) {
    return new Response(JSON.stringify({
      error: 'Failed to get access token'
    }), { 
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
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
          rowLimit: 100
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('GSC API error:', errorText);
      throw new Error(`GSC API error: ${response.status}`);
    }

    const data = await response.json();
    console.log('GSC API response:', data);

    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error fetching GSC data:', error);
    return new Response(JSON.stringify({
      error: 'Failed to fetch GSC data',
      details: error.message
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

router.post('/search-analytics', async (request) => {
    try {
      const { startDate, endDate, siteUrl } = await request.json();
      
      if (!startDate || !endDate || !siteUrl) {
        return new Response('Missing required parameters', { status: 400 });
      }
  
      const searchAnalytics = await getSearchAnalytics({
        startDate,
        endDate,
        siteUrl
      });
  
      return new Response(JSON.stringify(searchAnalytics), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error fetching search analytics:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  });
  
  async function getSearchAnalytics({ startDate, endDate, siteUrl }) {
    // Use the Google Search Console API client to fetch real data
    const searchAnalytics = await googleSearchConsole.searchanalytics.query({
      siteUrl: siteUrl,
      startDate: startDate,
      endDate: endDate,
      dimensions: ['query', 'page'],
      rowLimit: 250
    });
  
    return searchAnalytics.data;
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
  
  try {
    // Get user's GSC refresh token
    const user = await env.DB.prepare(
      'SELECT gsc_refresh_token, credits FROM users WHERE id = ?'
    ).bind(userId).first();

    if (!user.gsc_refresh_token) {
      return new Response(JSON.stringify({
        error: 'GSC not connected',
        needsConnection: true
      }), {
        status: 400,
        headers: corsHeaders
      });
    }

    // Get access token using refresh token
    const accessToken = await refreshToken(user.gsc_refresh_token, env);

    // Call GSC API
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
          rowLimit: 500 // We'll filter down to requested limit after getting data
        })
      }
    );

    if (!response.ok) {
      throw new Error(`GSC API error: ${response.status}`);
    }

    const gscData = await response.json();
    
    // Transform and return data
    const pages = gscData.rows.map(row => ({
      url: row.keys[0],
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position
    }));

    return new Response(JSON.stringify({
      pages,
      creditsRemaining: user.credits
    }), {
      headers: corsHeaders
    });

  } catch (error) {
    console.error('Error fetching top pages:', error);
    return new Response(JSON.stringify({
      error: 'Failed to fetch GSC data'
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

// Add route handlers
router
    .get('/properties', getProperties)
    .post('/search-analytics', fetchGSCData)
    .get('/top-pages', getTopPages);

export { router };