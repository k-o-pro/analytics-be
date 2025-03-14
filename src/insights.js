// Functions to generate insights using OpenAI API

// Generate overall insights
export async function generateInsights(request, env) {
  try {
    // Clone the request at the beginning to avoid "Body already used" errors
    const clonedRequest = request.clone();
    
    // Read the request body once and store the result
    const requestData = await clonedRequest.json();
    const userId = request.user.user_id;
    const { siteUrl, period, data } = requestData;

    // Enhanced validation
    if (!siteUrl) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Site URL is required'
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    // Check if we're in development mode or if mock data is requested
    const url = new URL(request.url);
    const returnMockData = url.searchParams.has('mock') || env.MOCK_OPENAI === 'true' || 
                          (data && data.useMock === true);
                          
    let generatedInsights = null; // Initialize the variable

    if (returnMockData) {
      console.log('Using mock data instead of calling OpenAI');
      generatedInsights = generateMockInsights(siteUrl, period);
      return new Response(JSON.stringify(generatedInsights), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Validate required OpenAI environment variables
    if (!env.OPENAI_API_KEY || !env.OPENAI_API_URL) {
      console.error('Missing OpenAI configuration:', {
        hasApiKey: !!env.OPENAI_API_KEY,
        hasApiUrl: !!env.OPENAI_API_URL
      });
      
      // Use default OpenAI API URL if not specified
      if (!env.OPENAI_API_URL) {
        env.OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
        console.log('Using default OpenAI API URL:', env.OPENAI_API_URL);
      }
      
      // If still missing API key, return error
      if (!env.OPENAI_API_KEY) {
        return new Response(JSON.stringify({
          success: false,
          error: 'OpenAI API key not configured'
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
    }

    // Check if user has already generated insights today
    const today = new Date().toISOString().split('T')[0];
    const existingInsight = await env.DB.prepare(
      `SELECT id FROM insights 
       WHERE user_id = ? AND site_url = ? AND date = ? AND type = 'overall'`
    ).bind(userId, siteUrl, today).first();

    // If insights exist and not forced refresh, return cached version
    const forcedRefresh = url.searchParams.has('force');
    if (existingInsight && !forcedRefresh) {
      const insight = await env.DB.prepare(
        'SELECT content FROM insights WHERE id = ?'
      ).bind(existingInsight.id).first();

      return new Response(insight.content, {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check credit usage for insights generation
    const user = await env.DB.prepare(
      'SELECT credits FROM users WHERE id = ?'
    ).bind(userId).first();

    if (user.credits < 1) {
      return new Response(JSON.stringify({
        error: 'Insufficient credits for insights generation'
      }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Prepare data for OpenAI
    const prompt = `
      Generate insights for a website based on the following Google Search Console data:
      
      Period: ${period}
      Site: ${siteUrl}
      
      Data: ${JSON.stringify(data)}
      
      Please analyze this data and provide insights on:
      1. Overall search performance trends
      2. Top performing keywords and pages
      3. Areas for improvement
      4. Specific actionable recommendations
      
      Format the response as a JSON object with the following structure:
      {
        "summary": "Brief executive summary",
        "performance": { "trend": "up/down/stable", "details": "..." },
        "topFindings": [ {"title": "...", "description": "..."} ],
        "recommendations": [ {"title": "...", "description": "...", "priority": "high/medium/low"} ]
      }
    `;

    // Prepare a safe version of the data to send to OpenAI
    const safeData = data ? {
      // Don't send potentially large datasets to OpenAI
      // Just include critical metrics and summary data
      property: data.property || siteUrl,
      period: period,
      targetUrl: data.targetPageUrl || null,
      // Add other safe fields as needed
    } : { property: siteUrl, period: period };
    
    // Enhanced debugging for request
    console.log('Calling OpenAI with request data:', {
      url: env.OPENAI_API_URL,
      model: "gpt-3.5-turbo", // Using the standard model which is more reliable
      apiKeyLength: env.OPENAI_API_KEY ? env.OPENAI_API_KEY.length : 0,
      promptLength: prompt.length
    });

    // Call OpenAI API with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // Increased to 60 second timeout for larger requests
    let openaiResponse;
    
    try {
      // Log the actual request being sent
      console.log('OpenAI API request:', {
        url: env.OPENAI_API_URL,
        model: "gpt-3.5-turbo",
        promptFirstChars: prompt.substring(0, 50),
        hasValidApiKey: !!env.OPENAI_API_KEY
      });
      
      // Double-check API URL format
      if (!env.OPENAI_API_URL.startsWith('http')) {
        env.OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
        console.log('Fixed OpenAI API URL format:', env.OPENAI_API_URL);
      }
      
      // Ensure valid API key format (starts with "sk-")
      if (env.OPENAI_API_KEY && !env.OPENAI_API_KEY.startsWith('sk-')) {
        console.error('Invalid OpenAI API key format - should start with "sk-"');
        
        // Return fallback insights instead of error
        const fallbackInsights = generateFallbackInsights(siteUrl, period);
        return new Response(JSON.stringify(fallbackInsights), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
            'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Max-Age': '86400'
          }
        });
      }
      
      // Make the API request with proper error handling
      try {
        openaiResponse = await fetch(env.OPENAI_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo", // Using the standard model which is more reliable
            messages: [
              { 
                role: "system", 
                content: "You are an SEO and website analytics expert. Provide concise, actionable insights. Format your entire response as a valid JSON object with the following structure: {\"summary\": \"Brief executive summary\", \"performance\": {\"trend\": \"up/down/stable\", \"details\": \"...\"}, \"topFindings\": [{\"title\": \"...\", \"description\": \"...\"}], \"recommendations\": [{\"title\": \"...\", \"description\": \"...\", \"priority\": \"high/medium/low\"}]}" 
              },
              { role: "user", content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 800
          }),
          signal: controller.signal
        });
      } catch (fetchInnerError) {
        // Detailed error logging for network issues
        console.error('Network error during OpenAI fetch:', fetchInnerError.name, fetchInnerError.message);
        throw fetchInnerError; // Re-throw to be caught by outer catch
      }
      
      // Log the response status
      console.log('OpenAI API response status:', openaiResponse.status, openaiResponse.statusText);
      
      clearTimeout(timeoutId); // Clear the timeout if the request completes

      // Clone the response before checking its status to avoid consuming the body
      const clonedResponse = openaiResponse.clone();
      
      if (!clonedResponse.ok) {
        // Log the detailed error for debugging
        let errorText = '';
        try {
          errorText = await clonedResponse.text();
        } catch (textError) {
          errorText = 'Could not read error response body';
        }
        
        console.error('OpenAI API error:', {
          status: clonedResponse.status,
          statusText: clonedResponse.statusText,
          errorDetails: errorText
        });
        
        // Return fallback insights instead of error
        const fallbackInsights = generateFallbackInsights(siteUrl, period);
        return new Response(JSON.stringify(fallbackInsights), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
            'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Max-Age': '86400'
          }
        });
      }
    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error('OpenAI fetch error:', fetchError.name, fetchError.message);
      
      // Return fallback insights instead of error
      const fallbackInsights = generateFallbackInsights(siteUrl, period);
      return new Response(JSON.stringify(fallbackInsights), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // Additional validation for OpenAI response
    let openaiData;
    try {
      openaiData = await openaiResponse.json();
      
      if (!openaiData.choices || !openaiData.choices[0] || !openaiData.choices[0].message) {
        console.error('Invalid OpenAI response format:', openaiData);
        throw new Error('Invalid OpenAI response format');
      }
      
      const content = openaiData.choices[0].message.content;
      console.log('Raw OpenAI response content:', content.substring(0, 100) + '...');
      
      // Parse the content as JSON
      if (typeof content === 'string' && content.trim().startsWith('{')) {
        generatedInsights = JSON.parse(content);
        
        // Validate required fields
        if (!generatedInsights.summary || 
            !generatedInsights.performance || 
            !generatedInsights.topFindings || 
            !generatedInsights.recommendations) {
          throw new Error('Missing required fields in OpenAI response');
        }
      } else {
        throw new Error('OpenAI response is not in JSON format');
      }

      // Use database transaction to ensure atomic operations
      try {
        await env.DB.batch([
          // Store insights in database
          env.DB.prepare(
            `INSERT OR REPLACE INTO insights (user_id, site_url, date, type, content, created_at)
            VALUES (?, ?, ?, 'overall', ?, ?)`
          ).bind(
            userId,
            siteUrl,
            today,
            JSON.stringify(generatedInsights),
            new Date().toISOString()
          ),
          
          // Deduct credit
          env.DB.prepare(
            'UPDATE users SET credits = credits - 1 WHERE id = ?'
          ).bind(userId)
        ]);
        
        console.log('Insights generated and stored successfully for user:', userId);
      } catch (dbError) {
        console.error('Database error during insights generation:', dbError);
        throw dbError;
      }

      // Return the successful insights response
      return new Response(JSON.stringify(generatedInsights), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400'
        }
      });

    } catch (error) {
      console.error('Error processing OpenAI response:', error);
      // Use fallback insights when OpenAI parsing fails
      const fallbackInsights = generateFallbackInsights(siteUrl, period);
      return new Response(JSON.stringify(fallbackInsights), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400'
        }
      });
    }
  } catch (error) {
    console.error('Error in generateInsights:', error);
    // Provide more specific error message based on the error type
    let errorMessage = 'Failed to generate insights';
    let statusCode = 500;
    
    if (error.name === 'SyntaxError' && error.message.includes('JSON')) {
      errorMessage = 'Invalid request format';
      statusCode = 400;
    } else if (error.message && error.message.includes('user_id')) {
      errorMessage = 'Authentication required';
      statusCode = 401;
    }
    
    // Return fallback insights instead of error if possible
    try {
      const fallbackInsights = generateFallbackInsights(
        error.siteUrl || "your website", 
        error.period || "the selected period"
      );
      return new Response(JSON.stringify(fallbackInsights), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400'
        }
      });
    } catch (fallbackError) {
      // If even the fallback generation fails, return an error
      return new Response(JSON.stringify({
        success: false,
        error: errorMessage,
        errorType: error.name,
        errorDetails: process.env.NODE_ENV === 'development' ? error.message : undefined
      }), {
        status: statusCode,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400'
        }
      });
    }
  }
}

// Generate page-specific insights
export async function generatePageInsights(request, env) {
  try {
    // Clone the request at the beginning to avoid "Body already used" errors
    const clonedRequest = request.clone();
    
    // Read the request body once and store the result
    const requestData = await clonedRequest.json();
    const userId = request.user.user_id;
    
    // Extract page URL from the path
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const pagePathEncoded = pathParts[pathParts.length - 1];
    const pagePath = decodeURIComponent(pagePathEncoded);
    
    const { siteUrl, period, data } = requestData;

    // Similar to generateInsights, but focused on a specific page
    // ...
  } catch (error) {
    console.error('Error in generatePageInsights:', error);
    // Provide more specific error message based on the error type
    let errorMessage = 'Failed to generate page insights';
    let statusCode = 500;
    
    if (error.name === 'SyntaxError' && error.message.includes('JSON')) {
      errorMessage = 'Invalid request format';
      statusCode = 400;
    } else if (error.message && error.message.includes('user_id')) {
      errorMessage = 'Authentication required';
      statusCode = 401;
    }
    
    // Return fallback insights instead of error if possible
    try {
      const fallbackInsights = generateFallbackInsights(
        error.siteUrl || "your website", 
        error.period || "the selected period"
      );
      return new Response(JSON.stringify(fallbackInsights), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400'
        }
      });
    } catch (fallbackError) {
      // If even the fallback generation fails, return an error
      return new Response(JSON.stringify({
        success: false,
        error: errorMessage,
        errorType: error.name,
        errorDetails: process.env.NODE_ENV === 'development' ? error.message : undefined
      }), {
        status: statusCode,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400'
        }
      });
    }
  }
}

// Helper function to generate fallback insights when OpenAI API fails
function generateFallbackInsights(siteUrl, period) {
  return {
    summary: `Analysis of site performance for ${siteUrl} during ${period}. This is a fallback analysis since the AI service is currently unavailable.`,
    performance: {
      trend: "stable",
      details: "Performance trend analysis is currently unavailable. Please check your Google Search Console for the most up-to-date metrics."
    },
    topFindings: [
      {
        title: "AI Analysis Unavailable",
        description: "Our AI analysis service is temporarily unavailable. We're working to restore it as soon as possible."
      },
      {
        title: "Basic SEO Recommendations",
        description: "In the meantime, we recommend checking your site for basic SEO best practices: meta descriptions, title tags, mobile-friendliness, and site speed."
      }
    ],
    recommendations: [
      {
        title: "Check Google Search Console",
        description: "Review your performance metrics directly in Google Search Console for the most accurate data.",
        priority: "high"
      },
      {
        title: "Try Again Later",
        description: "Our AI analysis service should be available again soon. Please try again in a few hours.",
        priority: "medium"
      },
      {
        title: "Monitor Keywords",
        description: "Keep track of your top-performing keywords and look for opportunities to improve rankings.",
        priority: "medium"
      }
    ]
  };
}

// Helper function to generate mock insights for testing
function generateMockInsights(siteUrl, period) {
  return {
    summary: `Analysis of ${siteUrl} shows relatively stable performance over ${period}. There are opportunities to improve CTR on some high-impression pages.`,
    performance: {
      trend: "up",
      details: "Overall impressions increased by 15% while clicks increased by 22%, indicating improving engagement."
    },
    topFindings: [
      {
        title: "Increased Mobile Traffic",
        description: "Mobile traffic has increased by 27% compared to the previous period, suggesting your site is performing well on mobile devices."
      },
      {
        title: "Strong Performance for Key Terms",
        description: "Your site ranks in top 5 positions for several important keywords, with good CTR for most."
      },
      {
        title: "Product Pages Underperforming",
        description: "Several product pages have high impressions but low CTR, indicating potential issues with meta descriptions or title tags."
      }
    ],
    recommendations: [
      {
        title: "Optimize Product Page Metadata",
        description: "Revise title tags and meta descriptions for product pages to improve CTR from search results.",
        priority: "high"
      },
      {
        title: "Create Content for Rising Keywords",
        description: "Develop new content targeting keywords that are showing increasing search volume in your niche.",
        priority: "medium"
      },
      {
        title: "Improve Page Load Speed",
        description: "Several key landing pages could benefit from performance optimization to improve Core Web Vitals metrics.",
        priority: "medium"
      }
    ]
  };
}

import { analyzeGSCData } from './services/aiRecommendations.js';
import { 
    AuthError, 
    ValidationError, 
    RateLimitError,
    createCorsHeaders,
    withErrorHandling,
    validateRequiredFields
} from './utils/errors.js';
import { checkRateLimit, generateGSCRateLimitKey } from './utils/rateLimiter.js';

/**
 * Get AI-powered insights and recommendations
 */
export const getInsights = withErrorHandling(async (request, env) => {
    const userId = request.user.user_id;
    const headers = createCorsHeaders(env.FRONTEND_URL);
    
    // Parse and validate request body
    const body = await request.json();
    validateRequiredFields(body, ['siteUrl', 'startDate', 'endDate']);
    
    const { siteUrl, startDate, endDate } = body;
    
    // Check rate limit before making API call
    const rateLimitKey = generateGSCRateLimitKey(userId, 'insights');
    const rateLimit = await checkRateLimit(env.GSC_CACHE, rateLimitKey, 50, 60); // 50 requests per minute
    
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
    
    // Query Search Console API for data
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
                dimensions: ['query', 'page'],
                rowLimit: 1000
            })
        }
    );
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new APIError(
            'Failed to fetch GSC data',
            response.status,
            'GSC_API_ERROR',
            { errorText }
        );
    }
    
    const data = await response.json();
    
    // Generate AI recommendations
    const recommendations = await analyzeGSCData(data, {
        dateRange: { startDate, endDate }
    });
    
    return new Response(JSON.stringify({
        success: true,
        data: recommendations
    }), {
        headers: headers
    });
});