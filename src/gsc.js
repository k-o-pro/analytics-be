// Functions to interact with Google Search Console API
import { refreshToken } from './auth.js';
import { getCachedData, setCachedData, generateGSCacheKey } from './utils/cache.js';
import { checkRateLimit, generateGSCRateLimitKey, createRateLimitResponse } from './utils/rateLimiter.js';
import { 
    AuthError, 
    ValidationError, 
    RateLimitError,
    createCorsHeaders,
    withErrorHandling,
    NotFoundError,
    APIError
} from './utils/errors.js';

// Helper function to validate required fields in request body
function validateRequiredFields(body, requiredFields) {
    const missingFields = requiredFields.filter(field => !body[field]);
    
    if (missingFields.length > 0) {
        throw new ValidationError('Missing required fields', {
            missing: missingFields
        });
    }
    
    return true;
}

// Get user's GSC properties
export const getProperties = withErrorHandling(async (request, env) => {
    const userId = request.user.user_id;
    const headers = createCorsHeaders(env.FRONTEND_URL);
    
    console.log(`Getting GSC properties for user ${userId}`);
    
    // Try to get cached data first
    const cacheKey = generateGSCacheKey(userId, 'properties');
    const cachedData = await getCachedData(env.GSC_CACHE, cacheKey);
    
    if (cachedData) {
        console.log(`Returning cached GSC properties for user ${userId}`);
        return new Response(JSON.stringify({
            success: true,
            data: cachedData,
            cached: true
        }), { headers });
    }
    
    // Check rate limit before making API call
    const rateLimitKey = generateGSCRateLimitKey(userId, 'properties');
    const rateLimit = await checkRateLimit(env.GSC_CACHE, rateLimitKey, 100, 60);
    
    if (rateLimit.limited) {
        throw new RateLimitError(
            'Rate limit exceeded',
            rateLimit.remaining,
            rateLimit.reset
        );
    }
    
    // Add rate limit headers to response
    headers['X-RateLimit-Remaining'] = rateLimit.remaining.toString();
    headers['X-RateLimit-Reset'] = rateLimit.reset.toString();
    
    // Check if user has connected GSC
    const user = await env.DB.prepare(
        'SELECT gsc_connected, gsc_refresh_token FROM users WHERE id = ?'
    ).bind(userId).first();
    
    if (!user || !user.gsc_connected || !user.gsc_refresh_token) {
        throw new ValidationError('Google Search Console not connected', {
            hasUser: !!user,
            connected: user?.gsc_connected,
            hasRefreshToken: !!user?.gsc_refresh_token
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
            throw new AuthError('Failed to refresh token', {
                status: refreshResult.status,
                statusText: refreshResult.statusText
            });
        }
        
        // Get new access token
        const newAccessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
        
        // Validate new token exists
        if (!newAccessToken) {
            throw new AuthError('Failed to refresh access token');
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
            
            throw new APIError(
                `Failed to fetch properties: ${errorText}`,
                response.status,
                'GSC_API_ERROR',
                { errorText }
            );
        }
        
        const data = await response.json();
        console.log('GSC API response data:', data);
        
        // Cache the successful response
        await setCachedData(env.GSC_CACHE, cacheKey, data, 3600); // Cache for 1 hour
        
        // Ensure we're directly exposing the siteEntry array for frontend consistency
        return new Response(JSON.stringify({
            success: true,
            siteEntry: data.siteEntry || [],
            cached: false
        }), { headers });
        
    } catch (error) {
        if (error instanceof APIError) {
            throw error;
        }
        throw new APIError(
            'Failed to fetch properties',
            500,
            'GSC_FETCH_ERROR',
            { error: error.message }
        );
    }
});

// Fetch GSC data for specified property
export const fetchGSCData = withErrorHandling(async (request, env) => {
    const userId = request.user.user_id;
    const headers = createCorsHeaders(env.FRONTEND_URL);
    
    try {
        // Parse and validate request body
        const body = await request.json();
        console.log(`Request body for fetchGSCData:`, JSON.stringify(body));
        validateRequiredFields(body, ['siteUrl', 'startDate', 'endDate']);
        
        const { siteUrl, startDate, endDate, dimensions = ['query', 'page'] } = body;
        
        console.log(`GSC data request for user ${userId}:`, {
            siteUrl,
            startDate,
            endDate,
            dimensions
        });
        
        // Check rate limit before making API call
        const rateLimitKey = generateGSCRateLimitKey(userId, 'searchAnalytics');
        const rateLimit = await checkRateLimit(env.GSC_CACHE, rateLimitKey, 100, 60);
        
        if (rateLimit.limited) {
            throw new RateLimitError(
                'Rate limit exceeded',
                rateLimit.remaining,
                rateLimit.reset
            );
        }
        
        // Add rate limit headers to response
        headers['X-RateLimit-Remaining'] = rateLimit.remaining.toString();
        headers['X-RateLimit-Reset'] = rateLimit.reset.toString();
        
        // Get access token from KV
        let accessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
        
        if (!accessToken) {
            // Token expired, try to refresh
            console.log(`Access token not found for user ${userId}, refreshing...`);
            const refreshResult = await refreshToken(request, env);
            if (!refreshResult.ok) {
                throw new AuthError('Failed to refresh token', {
                    status: refreshResult.status,
                    statusText: refreshResult.statusText
                });
            }
            
            // Get new access token
            const newAccessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
            
            // Validate new token exists
            if (!newAccessToken) {
                throw new AuthError('Failed to refresh access token');
            }
            
            accessToken = newAccessToken;
        }
        
        // Normalize and handle different site URL formats
        // GSC URLs can be in different formats: sc-domain:example.com, https://example.com/, etc.
        let siteDomain = siteUrl;
        
        // Log the input URL to help debug
        console.log(`Original site URL: ${siteUrl}`);
        
        // Make sure URLs are correctly formatted for the GSC API
        if (!siteUrl.startsWith('sc-domain:') && !siteUrl.startsWith('http://') && !siteUrl.startsWith('https://')) {
            console.log(`Adding sc-domain: prefix to ${siteUrl}`);
            siteDomain = `sc-domain:${siteUrl}`;
        } else {
            siteDomain = siteUrl;
        }
        
        // Properly encode the URL
        let encodedSiteUrl = encodeURIComponent(siteDomain);
        console.log(`Encoded site URL: ${encodedSiteUrl}`);
        
        // Query Search Console API
        console.log(`Fetching GSC data for ${siteUrl} from ${startDate} to ${endDate}`);
        const requestBody = {
            startDate,
            endDate,
            dimensions,
            rowLimit: 500
        };
        
        console.log(`Request body: ${JSON.stringify(requestBody)}`);
        
        try {
            const apiUrl = `https://www.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`;
            console.log(`API URL: ${apiUrl}`);
            
            const response = await fetch(
                apiUrl,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestBody)
                }
            );
            
            // Log the GSC API response status to help debug
            console.log(`GSC API response status: ${response.status}`);
            
            if (!response.ok) {
                // Clone the response before reading the body
                const responseClone = response.clone();
                const errorText = await responseClone.text();
                console.error(`GSC API error (${response.status}):`, errorText);
                
                // If unauthorized, token might be invalid, try refreshing once
                if (response.status === 401) {
                    console.log('Access token invalid, refreshing and retrying...');
                    await env.AUTH_STORE.delete(`gsc_token:${userId}`);
                    
                    // Refresh token
                    const refreshResult = await refreshToken(request, env);
                    if (!refreshResult.ok) {
                        throw new AuthError('Failed to refresh token after 401', {
                            status: refreshResult.status,
                            statusText: refreshResult.statusText
                        });
                    }
                    
                    // Get new access token
                    const newAccessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
                    if (!newAccessToken) {
                        throw new AuthError('Failed to get new access token after refresh');
                    }
                    
                    // Retry with new token
                    const retryResponse = await fetch(
                        apiUrl,
                        {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${newAccessToken}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(requestBody)
                        }
                    );
                    
                    if (!retryResponse.ok) {
                        // Clone the retry response before reading the body
                        const retryResponseClone = retryResponse.clone();
                        const retryErrorText = await retryResponseClone.text();
                        console.error(`GSC API retry error (${retryResponse.status}):`, retryErrorText);
                        
                        // Provide detailed error information
                        throw new APIError(
                            `Failed to fetch GSC data after token refresh: ${retryErrorText}`,
                            retryResponse.status,
                            'GSC_API_ERROR',
                            { 
                                errorText: retryErrorText,
                                siteUrl,
                                encodedSiteUrl,
                                startDate,
                                endDate
                            }
                        );
                    }
                    
                    const retryData = await retryResponse.json();
                    console.log(`Successfully fetched GSC data after token refresh for ${siteUrl}`);
                    
                    return new Response(JSON.stringify({
                        success: true,
                        data: retryData,
                        retried: true
                    }), {
                        headers: headers
                    });
                }
                
                // Handle property not found (404) error specifically
                if (response.status === 404) {
                    console.log(`No data found for property ${siteUrl}`);
                    
                    // Check if site URL might be in the wrong format and suggest alternatives
                    let errorMessage = 'No data available for this property.';
                    let suggestions = [];
                    
                    if (!siteUrl.startsWith('sc-domain:') && !siteUrl.startsWith('http')) {
                        suggestions.push(`sc-domain:${siteUrl}`);
                    }
                    
                    if (siteUrl.startsWith('https://') || siteUrl.startsWith('http://')) {
                        // Remove trailing slash if present
                        const domainOnly = siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
                        suggestions.push(`sc-domain:${domainOnly}`);
                    }
                    
                    if (suggestions.length > 0) {
                        errorMessage += ` You might try using one of these formats instead: ${suggestions.join(', ')}`;
                    }
                    
                    return new Response(JSON.stringify({
                        success: true,
                        data: { rows: [] },
                        message: errorMessage,
                        notFound: true,
                        suggestions
                    }), {
                        headers: headers
                    });
                }
                
                // Handle permission errors (403 Forbidden)
                if (response.status === 403) {
                    console.log(`User does not have permission for site ${siteUrl}`);
                    
                    // Clone the response before reading the body
                    const responseClone = response.clone();
                    const errorText = await responseClone.text();
                    console.error(`GSC API error (${response.status}):`, errorText);
                    
                    // Parse the error message to extract the reason
                    let errorMessage = 'You do not have permission to access this site in Google Search Console.';
                    try {
                        const errorData = JSON.parse(errorText);
                        if (errorData.error && errorData.error.message) {
                            errorMessage = errorData.error.message;
                        }
                    } catch (parseError) {
                        console.error('Error parsing 403 response:', parseError);
                    }
                    
                    // Return a more user-friendly response
                    return new Response(JSON.stringify({
                        success: false,
                        error: errorMessage,
                        code: 'PERMISSION_DENIED',
                        data: { rows: [] },
                        permissionDenied: true
                    }), {
                        status: 403,
                        headers: headers
                    });
                }
                
                // Provide more detailed error information
                throw new APIError(
                    `Failed to fetch GSC data: ${errorText}`,
                    response.status,
                    'GSC_API_ERROR',
                    { 
                        errorText,
                        siteUrl,
                        encodedSiteUrl,
                        startDate,
                        endDate 
                    }
                );
            }
            
            const data = await response.json();
            console.log(`Successfully fetched GSC data for ${siteUrl}, rows:`, data.rows?.length || 0);
            
            // Store data in database for historical tracking
            const timestamp = new Date().toISOString();
            const dataJson = JSON.stringify(data);
            
            try {
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
            } catch (error) {
                console.error('Failed to store GSC data:', error);
                // Don't throw here, as the API call was successful
            }
            
            return new Response(JSON.stringify({
                success: true,
                data: data
            }), {
                headers: headers
            });
        } catch (error) {
            console.error('Error in fetchGSCData:', error);
            
            // Provide a clearer error response
            const errorResponse = {
                success: false,
                error: error.message || 'Unknown error occurred',
                errorCode: error.code || 'UNKNOWN_ERROR',
                errorDetails: error.details || {}
            };
            
            const statusCode = error.status || 500;
            
            return new Response(JSON.stringify(errorResponse), {
                status: statusCode,
                headers: headers
            });
        }
    } catch (error) {
        console.error('Error in fetchGSCData:', error);
        
        // Provide a clearer error response
        const errorResponse = {
            success: false,
            error: error.message || 'Unknown error occurred',
            errorCode: error.code || 'UNKNOWN_ERROR',
            errorDetails: error.details || {}
        };
        
        const statusCode = error.status || 500;
        
        return new Response(JSON.stringify(errorResponse), {
            status: statusCode,
            headers: headers
        });
    }
});

// Get top pages
export const getTopPages = withErrorHandling(async (request, env) => {
    const userId = request.user.user_id;
    const headers = createCorsHeaders(env.FRONTEND_URL);
    
    const url = new URL(request.url);
    const siteUrl = url.searchParams.get('siteUrl');
    const startDate = url.searchParams.get('startDate');
    const endDate = url.searchParams.get('endDate');
    
    // Validate required parameters
    if (!siteUrl || !startDate || !endDate) {
        throw new ValidationError('Missing required parameters', {
            missing: {
                siteUrl: !siteUrl,
                startDate: !startDate,
                endDate: !endDate
            }
        });
    }
    
    // Check rate limit before making API call
    const rateLimitKey = generateGSCRateLimitKey(userId, 'topPages');
    const rateLimit = await checkRateLimit(env.GSC_CACHE, rateLimitKey, 100, 60);
    
    if (rateLimit.limited) {
        throw new RateLimitError(
            'Rate limit exceeded',
            rateLimit.remaining,
            rateLimit.reset
        );
    }
    
    // Add rate limit headers to response
    headers['X-RateLimit-Remaining'] = rateLimit.remaining.toString();
    headers['X-RateLimit-Reset'] = rateLimit.reset.toString();
    
    // Check if user has enough credits for more than 10 pages
    const user = await env.DB.prepare(
        'SELECT credits FROM users WHERE id = ?'
    ).bind(userId).first();
    
    if (!user) {
        throw new NotFoundError('User not found');
    }
    
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
    
    // Get access token from KV
    let accessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
    
    if (!accessToken) {
        const refreshResult = await refreshToken(request, env);
        if (!refreshResult.ok) {
            throw new AuthError('Failed to refresh token', {
                status: refreshResult.status,
                statusText: refreshResult.statusText
            });
        }
        
        const newAccessToken = await env.AUTH_STORE.get(`gsc_token:${userId}`);
        if (!newAccessToken) {
            throw new AuthError('Failed to refresh access token');
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
        const errorText = await response.text();
        throw new APIError(
            'Failed to fetch top pages',
            response.status,
            'GSC_API_ERROR',
            { errorText }
        );
    }
    
    const data = await response.json();
    
    const result = {
        success: true,
        pages: data.rows || [],
        limit: pageLimit,
        creditsRemaining: user.credits - (pageLimit > 10 ? 1 : 0)
    };
    
    return new Response(JSON.stringify(result), {
        headers: headers
    });
});