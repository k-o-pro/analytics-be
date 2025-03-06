// Functions to interact with Google Search Console API
import { refreshToken } from './auth.js';

// Get user's GSC properties
export async function getProperties(request, env) {
  const userId = request.user.user_id;
  
  // Define common headers including CORS
  const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': env.FRONTEND_URL || 'https://analytics.k-o.pro',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true'
  };
  
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
          headers: headers
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
              headers: headers
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
              headers: headers
          });
      }
      
      const data = await response.json();
      console.log(`Successfully fetched ${data.siteEntry?.length || 0} GSC properties for user ${userId}`);
      
      return new Response(JSON.stringify({
          success: true,
          ...data
      }), {
          headers: headers
      });
  } catch (error) {
      console.error(`Error fetching GSC properties for user ${userId}:`, error);
      return new Response(JSON.stringify({
          success: false,
          error: `Failed to fetch properties: ${error.message}`
      }), { 
          status: 500,
          headers: headers
      });
  }
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