// Functions to generate insights using OpenAI API
import { createCorsHeaders } from './utils/errors.js';

// Generate overall insights
export async function generateInsights(request, env) {
  try {
    // Clone the request at the beginning to avoid "Body already used" errors
    const clonedRequest = request.clone();
    
    // Set up CORS headers early so they're available for all responses
    const corsHeaders = createCorsHeaders(env.FRONTEND_URL);
    
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
        headers: corsHeaders
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
        headers: corsHeaders
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
          headers: corsHeaders
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
        headers: corsHeaders
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
        headers: corsHeaders
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
      
      IMPORTANT: Only use actual URLs, keywords and metrics from the provided data. DO NOT use placeholder values like 'keyword1', 'example-page1', or 'X%'. Always refer to real keywords, real pages, and exact percentage values from the data.
      
      Format the response as a JSON object with the following structure:
      {
        "summary": "Concise 2-3 sentence executive summary highlighting the most significant trend and business impact",
        
        "performance": {
          "trend": "up/down/stable/mixed",
          "changePercent": "numerical percentage of overall change",
          "timePeriod": "specify the analyzed time period",
          "keyMetricChanges": [
            {"metric": "clicks", "change": "+/-X%", "interpretation": "brief interpretation"},
            {"metric": "impressions", "change": "+/-X%", "interpretation": "brief interpretation"},
            {"metric": "ctr", "change": "+/-X%", "interpretation": "brief interpretation"},
            {"metric": "position", "change": "+/-X%", "interpretation": "brief interpretation"}
          ],
          "details": "Deeper analysis of performance trends including correlations between metrics"
        },
        
        "topFindings": [
          {
            "title": "Clear, specific finding title",
            "description": "Detailed explanation with specific numbers and percentages",
            "impactLevel": "high/medium/low",
            "dataPoints": ["Specific supporting data point 1", "Specific supporting data point 2"]
          }
        ],
        
        "opportunities": [
          {
            "title": "Specific opportunity title",
            "description": "Clear explanation of the opportunity with estimated potential impact",
            "estimatedImpact": "Quantified potential improvement (e.g., '+10-15% CTR')",
            "difficulty": "easy/moderate/complex",
            "timeFrame": "immediate/short-term/long-term"
          }
        ],
        
        "recommendations": [
          {
            "title": "Action-oriented recommendation title",
            "description": "Detailed, step-by-step explanation of implementation",
            "priority": "high/medium/low",
            "expectedOutcome": "Specific, measurable result expected",
            "implementationSteps": ["Step 1...", "Step 2..."]
          }
        ],
        
        "keywordInsights": {
          "risingKeywords": ["keyword 1", "keyword 2"],
          "decliningKeywords": ["keyword 3", "keyword 4"],
          "missedOpportunities": ["keyword 5", "keyword 6"],
          "analysis": "Brief analysis of keyword trends and patterns"
        }
      }

      When analyzing data:
      1. Prioritize insights that show clear causation, not just correlation
      2. Focus on actionable findings that can drive measurable improvements
      3. Provide specific, quantifiable metrics rather than general statements
      4. Highlight unexpected patterns or anomalies that deserve attention
      5. Consider technical SEO issues, content quality, user experience, and competitive factors
      6. Always explain the business impact of technical findings
      7. Ensure recommendations are specific, realistic, and prioritized by impact vs. effort

      Tailor your analysis to the site's industry, size, and performance level evident in the data.
      
      Remember: Use ONLY actual keywords, URLs, and metrics from the provided data. Do not use placeholders.
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
      model: "gpt-4o-2024-08-06", // Update logging to show the new model
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
        model: "gpt-4o-2024-08-06", // Update logging to show the new model
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
          headers: corsHeaders
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
            model: "gpt-4o-2024-08-06", // Changed from gpt-3.5-turbo to the more advanced GPT-4o model
            messages: [
              { 
                role: "system", 
                content: `You are an elite SEO and website analytics expert with 15+ years of experience in search performance analysis. Your task is to deliver strategic, data-driven insights that combine technical expertise with business value.

Format your entire response as a valid JSON object with the following structure:

{
  "summary": "Concise 2-3 sentence executive summary highlighting the most significant trend and business impact",
  
  "performance": {
    "trend": "up/down/stable/mixed",
    "changePercent": "numerical percentage of overall change",
    "timePeriod": "specify the analyzed time period",
    "keyMetricChanges": [
      {"metric": "clicks", "change": "+/-X%", "interpretation": "brief interpretation"},
      {"metric": "impressions", "change": "+/-X%", "interpretation": "brief interpretation"},
      {"metric": "ctr", "change": "+/-X%", "interpretation": "brief interpretation"},
      {"metric": "position", "change": "+/-X%", "interpretation": "brief interpretation"}
    ],
    "details": "Deeper analysis of performance trends including correlations between metrics"
  },
  
  "topFindings": [
    {
      "title": "Clear, specific finding title",
      "description": "Detailed explanation with specific numbers and percentages",
      "impactLevel": "high/medium/low",
      "dataPoints": ["Specific supporting data point 1", "Specific supporting data point 2"]
    }
  ],
  
  "opportunities": [
    {
      "title": "Specific opportunity title",
      "description": "Clear explanation of the opportunity with estimated potential impact",
      "estimatedImpact": "Quantified potential improvement (e.g., '+10-15% CTR')",
      "difficulty": "easy/moderate/complex",
      "timeFrame": "immediate/short-term/long-term"
    }
  ],
  
  "recommendations": [
    {
      "title": "Action-oriented recommendation title",
      "description": "Detailed, step-by-step explanation of implementation",
      "priority": "high/medium/low",
      "expectedOutcome": "Specific, measurable result expected",
      "implementationSteps": ["Step 1...", "Step 2..."]
    }
  ],
  
  "keywordInsights": {
    "risingKeywords": ["keyword 1", "keyword 2"],
    "decliningKeywords": ["keyword 3", "keyword 4"],
    "missedOpportunities": ["keyword 5", "keyword 6"],
    "analysis": "Brief analysis of keyword trends and patterns"
  }
}

IMPORTANT: You must only use the real data provided from Google Search Console. Do not use placeholder values like 'keyword1', 'keyword2', 'example-page1', etc. Always refer to actual keywords, pages, and metrics from the data.

When analyzing data:
1. Prioritize insights that show clear causation, not just correlation
2. Focus on actionable findings that can drive measurable improvements
3. Provide specific, quantifiable metrics rather than general statements
4. Highlight unexpected patterns or anomalies that deserve attention
5. Consider technical SEO issues, content quality, user experience, and competitive factors
6. Always explain the business impact of technical findings
7. Ensure recommendations are specific, realistic, and prioritized by impact vs. effort

Tailor your analysis to the site's industry, size, and performance level evident in the data.` 
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
          headers: corsHeaders
        });
      }
    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error('OpenAI fetch error:', fetchError.name, fetchError.message);
      
      // Return fallback insights instead of error
      const fallbackInsights = generateFallbackInsights(siteUrl, period);
      return new Response(JSON.stringify(fallbackInsights), {
        headers: corsHeaders
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
            !generatedInsights.recommendations ||
            !generatedInsights.opportunities ||
            !generatedInsights.keywordInsights) {
          console.warn('Missing some required fields in OpenAI response. Using fallback format.');
          
          // Add missing fields with basic structure to avoid frontend errors
          if (!generatedInsights.opportunities) {
            generatedInsights.opportunities = [];
          }
          
          if (!generatedInsights.keywordInsights) {
            generatedInsights.keywordInsights = {
              risingKeywords: [],
              decliningKeywords: [],
              missedOpportunities: [],
              analysis: "No keyword analysis available"
            };
          }
          
          // Ensure performance object has the expected structure
          if (generatedInsights.performance && !generatedInsights.performance.keyMetricChanges) {
            generatedInsights.performance.keyMetricChanges = [
              {metric: "clicks", change: "0%", interpretation: "No data available"},
              {metric: "impressions", change: "0%", interpretation: "No data available"},
              {metric: "ctr", change: "0%", interpretation: "No data available"},
              {metric: "position", change: "0%", interpretation: "No data available"}
            ];
          }
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
        headers: corsHeaders
      });

    } catch (error) {
      console.error('Error processing OpenAI response:', error);
      // Use fallback insights when OpenAI parsing fails
      const fallbackInsights = generateFallbackInsights(siteUrl, period);
      return new Response(JSON.stringify(fallbackInsights), {
        headers: corsHeaders
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
        headers: corsHeaders
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
        headers: corsHeaders
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
        headers: corsHeaders
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
        headers: corsHeaders
      });
    }
  }
}

// Helper function to generate fallback insights when OpenAI API fails
function generateFallbackInsights(siteUrl, period) {
  return {
    summary: `[FALLBACK DATA] Analysis of site performance for ${siteUrl} during ${period}. This is a fallback analysis since the AI service is currently unavailable.`,
    performance: {
      trend: "stable",
      changePercent: "0%",
      timePeriod: period,
      keyMetricChanges: [
        {metric: "clicks", change: "0%", interpretation: "[FALLBACK] Data temporarily unavailable"},
        {metric: "impressions", change: "0%", interpretation: "[FALLBACK] Data temporarily unavailable"},
        {metric: "ctr", change: "0%", interpretation: "[FALLBACK] Data temporarily unavailable"},
        {metric: "position", change: "0%", interpretation: "[FALLBACK] Data temporarily unavailable"}
      ],
      details: "[FALLBACK DATA] Performance trend analysis is currently unavailable. Please check your Google Search Console for the most up-to-date metrics."
    },
    topFindings: [
      {
        title: "[FALLBACK] AI Analysis Unavailable",
        description: "Our AI analysis service is temporarily unavailable. We're working to restore it as soon as possible.",
        impactLevel: "medium",
        dataPoints: ["[FALLBACK] Service disruption detected", "[FALLBACK] Engineering team notified"]
      },
      {
        title: "[FALLBACK] Basic SEO Recommendations",
        description: "In the meantime, we recommend checking your site for basic SEO best practices: meta descriptions, title tags, mobile-friendliness, and site speed.",
        impactLevel: "medium",
        dataPoints: ["[FALLBACK] These are general best practices", "[FALLBACK] Specific data analysis will resume soon"]
      }
    ],
    opportunities: [
      {
        title: "[FALLBACK] Review Previous Insights",
        description: "While waiting for the service to be restored, you can review previous insights and implement any pending recommendations.",
        estimatedImpact: "[FALLBACK] Varies by recommendation",
        difficulty: "easy",
        timeFrame: "immediate"
      }
    ],
    recommendations: [
      {
        title: "[FALLBACK] Check Google Search Console",
        description: "Review your performance metrics directly in Google Search Console for the most accurate data.",
        priority: "high",
        expectedOutcome: "[FALLBACK] Access to accurate, real-time data",
        implementationSteps: ["[FALLBACK] Log in to Google Search Console", "[FALLBACK] Review Performance section"]
      },
      {
        title: "[FALLBACK] Try Again Later",
        description: "Our AI analysis service should be available again soon. Please try again in a few hours.",
        priority: "medium",
        expectedOutcome: "[FALLBACK] Access to AI-powered insights",
        implementationSteps: ["[FALLBACK] Check back in 2-3 hours"]
      },
      {
        title: "[FALLBACK] Monitor Keywords",
        description: "Keep track of your top-performing keywords and look for opportunities to improve rankings.",
        priority: "medium",
        expectedOutcome: "[FALLBACK] Maintain awareness of keyword performance",
        implementationSteps: ["[FALLBACK] Check positions for key terms", "[FALLBACK] Note any significant changes"]
      }
    ],
    keywordInsights: {
      risingKeywords: ["[FALLBACK] No data available"],
      decliningKeywords: ["[FALLBACK] No data available"],
      missedOpportunities: ["[FALLBACK] No data available"],
      analysis: "[FALLBACK DATA] Keyword trend analysis is temporarily unavailable."
    }
  };
}

// Helper function to generate mock insights for testing
function generateMockInsights(siteUrl, period) {
  return {
    summary: `[MOCK DATA] Analysis of ${siteUrl} shows improvement in overall performance over ${period}. This is generated mock data for testing purposes only and does not represent actual GSC data.`,
    performance: {
      trend: "up",
      changePercent: "15%",
      timePeriod: period,
      keyMetricChanges: [
        {metric: "clicks", change: "+22%", interpretation: "Strong growth indicating improved visibility and relevance [MOCK DATA]"},
        {metric: "impressions", change: "+15%", interpretation: "Expanded reach in search results [MOCK DATA]"},
        {metric: "ctr", change: "+8%", interpretation: "Better engagement with search snippets [MOCK DATA]"},
        {metric: "position", change: "-0.7", interpretation: "Improved average ranking positions [MOCK DATA]"}
      ],
      details: "[MOCK DATA] This is simulated performance data for testing purposes. In a real analysis, this would contain detailed trends based on actual GSC metrics."
    },
    topFindings: [
      {
        title: "[MOCK DATA] Mobile Traffic Trend",
        description: "This is mock data for testing purposes. Real analysis would include actual metrics and specific insights based on your GSC data.",
        impactLevel: "high",
        dataPoints: ["Mock data point 1", "Mock data point 2", "Mock data point 3"]
      },
      {
        title: "[MOCK DATA] Search Performance",
        description: "This is mock data for testing purposes. Real analysis would include actual metrics and specific insights based on your GSC data.",
        impactLevel: "high",
        dataPoints: ["Mock data point 1", "Mock data point 2"]
      },
      {
        title: "[MOCK DATA] Content Performance",
        description: "This is mock data for testing purposes. Real analysis would include actual metrics and specific insights based on your GSC data.",
        impactLevel: "medium",
        dataPoints: ["Mock data point 1", "Mock data point 2"]
      }
    ],
    opportunities: [
      {
        title: "[MOCK DATA] Opportunity 1",
        description: "This is mock data for testing purposes. Real analysis would include specific opportunities based on your actual GSC data.",
        estimatedImpact: "[MOCK] Impact estimate",
        difficulty: "easy",
        timeFrame: "short-term"
      },
      {
        title: "[MOCK DATA] Opportunity 2",
        description: "This is mock data for testing purposes. Real analysis would include specific opportunities based on your actual GSC data.",
        estimatedImpact: "[MOCK] Impact estimate",
        difficulty: "moderate",
        timeFrame: "medium-term"
      },
      {
        title: "[MOCK DATA] Opportunity 3",
        description: "This is mock data for testing purposes. Real analysis would include specific opportunities based on your actual GSC data.",
        estimatedImpact: "[MOCK] Impact estimate",
        difficulty: "complex",
        timeFrame: "long-term"
      }
    ],
    recommendations: [
      {
        title: "[MOCK DATA] Recommendation 1",
        description: "This is mock data for testing purposes. Real recommendations would be based on your actual GSC data.",
        priority: "high",
        expectedOutcome: "[MOCK] Expected outcome",
        implementationSteps: [
          "[MOCK] Step 1",
          "[MOCK] Step 2",
          "[MOCK] Step 3"
        ]
      },
      {
        title: "[MOCK DATA] Recommendation 2",
        description: "This is mock data for testing purposes. Real recommendations would be based on your actual GSC data.",
        priority: "medium",
        expectedOutcome: "[MOCK] Expected outcome",
        implementationSteps: [
          "[MOCK] Step 1",
          "[MOCK] Step 2"
        ]
      },
      {
        title: "[MOCK DATA] Recommendation 3",
        description: "This is mock data for testing purposes. Real recommendations would be based on your actual GSC data.",
        priority: "medium",
        expectedOutcome: "[MOCK] Expected outcome",
        implementationSteps: [
          "[MOCK] Step 1",
          "[MOCK] Step 2",
          "[MOCK] Step 3"
        ]
      }
    ],
    keywordInsights: {
      risingKeywords: ["[MOCK] Rising keyword 1", "[MOCK] Rising keyword 2", "[MOCK] Rising keyword 3"],
      decliningKeywords: ["[MOCK] Declining keyword 1", "[MOCK] Declining keyword 2"],
      missedOpportunities: ["[MOCK] Missed opportunity 1", "[MOCK] Missed opportunity 2"],
      analysis: "[MOCK DATA] This is simulated keyword analysis for testing purposes. Real analysis would include actual keywords and trends from your GSC data."
    }
  };
}

import { analyzeGSCData } from './services/aiRecommendations.js';
import { 
    AuthError, 
    ValidationError, 
    RateLimitError,
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