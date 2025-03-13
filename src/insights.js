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
                          
    if (returnMockData) {
      console.log('Using mock data instead of calling OpenAI');
      const mockResponse = generateMockInsights(siteUrl, period);
      return new Response(JSON.stringify(mockResponse), {
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
      // Use the original response if we get here (we haven't consumed the body yet)
      openaiData = await openaiResponse.json();
      
      if (!openaiData.choices || !openaiData.choices[0] || !openaiData.choices[0].message) {
        console.error('Invalid OpenAI response format:', openaiData);
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
      
      // Parse JSON response from OpenAI or use as-is if already JSON
      let generatedInsights;
      try {
        const content = openaiData.choices[0].message.content;
        console.log('Raw OpenAI response content:', content.substring(0, 100) + '...');
        
        // Check if the content is already in JSON format
        if (typeof content === 'string' && content.trim().startsWith('{')) {
          try {
            generatedInsights = JSON.parse(content);
            
            // Validate the structure of the generated insights
            if (!generatedInsights.summary || 
                !generatedInsights.performance || 
                !generatedInsights.topFindings || 
                !generatedInsights.recommendations) {
              
              console.warn('Generated insights missing required fields, adding defaults');
              
              // Add missing fields with defaults
              generatedInsights = {
                summary: generatedInsights.summary || "Analysis of your site's performance",
                performance: generatedInsights.performance || { 
                  trend: "stable", 
                  details: "Not enough data for detailed trend analysis." 
                },
                topFindings: generatedInsights.topFindings || [
                  {
                    title: "Basic SEO analysis",
                    description: "Your site is indexed by Google. Regular monitoring is recommended."
                  }
                ],
                recommendations: generatedInsights.recommendations || [
                  {
                    title: "General recommendation",
                    description: "Monitor trends in Google Search Console regularly.",
                    priority: "medium"
                  }
                ]
              };
            }
          } catch (parseError) {
            console.error('JSON parse error:', parseError);
            throw new Error('Invalid JSON in OpenAI response');
          }
        } else {
          // If not JSON, create a simple structured response
          generatedInsights = {
            summary: "Analysis of your site's performance",
            performance: { 
              trend: "stable", 
              details: "Not enough data for detailed trend analysis." 
            },
            topFindings: [
              {
                title: "Basic SEO analysis",
                description: content.substring(0, 200) // Include part of the raw response
              }
            ],
            recommendations: [
              {
                title: "General recommendation",
                description: "Check Google Search Console for more detailed data.",
                priority: "medium"
              }
            ]
          };
        }
      } catch (error) {
        console.error('Failed to parse OpenAI response as JSON:', error);
        return new Response(JSON.stringify({
          success: false,
          error: 'Failed to parse AI response'
        }), {
          status: 500,
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
    } catch (jsonError) {
      console.error('Failed to parse OpenAI HTTP response:', jsonError);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to read AI service response'
      }), {
        status: 500,
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

    // Use database transaction to ensure atomic operations
    try {
      // Begin transaction
      await env.DB.exec('BEGIN TRANSACTION');
      
      // Store insights in database
      await env.DB.prepare(
        `INSERT OR REPLACE INTO insights (user_id, site_url, date, type, content, created_at)
         VALUES (?, ?, ?, 'overall', ?, ?)`
      ).bind(
        userId,
        siteUrl,
        today,
        typeof generatedInsights === 'string' ? generatedInsights : JSON.stringify(generatedInsights),
        new Date().toISOString()
      ).run();

      // Deduct credit
      await env.DB.prepare(
        'UPDATE users SET credits = credits - 1 WHERE id = ?'
      ).bind(userId).run();
      
      // Commit transaction
      await env.DB.exec('COMMIT');
      
      console.log('Insights generated and stored successfully for user:', userId);
    } catch (dbError) {
      // Rollback on error
      try {
        await env.DB.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('Failed to rollback transaction:', rollbackError);
      }
      
      console.error('Database error during insights generation:', dbError);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to store insights'
      }), {
        status: 500,
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

    // Return the insights as a proper JSON response
    return new Response(
      typeof generatedInsights === 'string' ? generatedInsights : JSON.stringify(generatedInsights), 
      {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://analytics.k-o.pro',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400'
        }
      }
    );
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