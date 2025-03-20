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
        "raw_data": {
          "metrics": {
            "clicks": [actual numbers from data],
            "impressions": [actual numbers from data],
            "ctr": [actual numbers from data],
            "position": [actual numbers from data]
          },
          "top_keywords": [list of actual top keywords with metrics],
          "top_pages": [list of actual top pages with metrics],
          "time_period": "${period}"
        },
        "ai_analysis": {
          "summary": "Concise 2-3 sentence executive summary highlighting the most significant trend and business impact",
          
          "performance": {
            "trend": "up/down/stable/mixed",
            "changePercent": "numerical percentage of overall change",
            "timePeriod": "${period}",
            "keyMetricChanges": [
              {"metric": "clicks", "change": "+/-X%", "interpretation": "brief interpretation based ONLY on actual data"},
              {"metric": "impressions", "change": "+/-X%", "interpretation": "brief interpretation based ONLY on actual data"},
              {"metric": "ctr", "change": "+/-X%", "interpretation": "brief interpretation based ONLY on actual data"},
              {"metric": "position", "change": "+/-X%", "interpretation": "brief interpretation based ONLY on actual data"}
            ],
            "details": "Deeper analysis of performance trends including correlations between metrics"
          },
          
          "topFindings": [
            {
              "title": "Clear, specific finding title",
              "description": "Detailed explanation with specific numbers and percentages from the raw data",
              "impactLevel": "high/medium/low",
              "dataPoints": ["Specific supporting data point 1 from raw data", "Specific supporting data point 2 from raw data"]
            }
          ],
          
          "opportunities": [
            {
              "title": "Specific opportunity title",
              "description": "Clear explanation of the opportunity based on actual data patterns",
              "estimatedImpact": "Quantified potential improvement (e.g., '+10-15% CTR')",
              "difficulty": "easy/moderate/complex",
              "timeFrame": "immediate/short-term/long-term"
            }
          ],
          
          "recommendations": [
            {
              "title": "Action-oriented recommendation title",
              "description": "Detailed, step-by-step explanation of implementation based on actual data patterns",
              "priority": "high/medium/low",
              "expectedOutcome": "Specific, measurable result expected based on the data",
              "implementationSteps": ["Step 1...", "Step 2..."]
            }
          ],
          
          "keywordInsights": {
            "risingKeywords": ["keyword 1 from raw data", "keyword 2 from raw data"],
            "decliningKeywords": ["keyword 3 from raw data", "keyword 4 from raw data"],
            "missedOpportunities": ["keyword 5 from raw data", "keyword 6 from raw data"],
            "analysis": "Brief analysis of keyword trends and patterns"
          }
        }
      }
      
      CRITICAL INSTRUCTIONS:
      1. The "raw_data" section must ONLY contain actual metrics and values from the provided data. No interpretations or analysis.
      2. The "ai_analysis" section can provide insights, but must base ALL claims on the actual data in raw_data.
      3. Never invent metrics, percentages, or numbers that aren't in the provided data.
      4. If specific data is missing for any field, indicate this with "insufficient data" rather than making up values.
      5. Only list keywords and pages that actually appear in the raw data.
      
      Remember: Use ONLY actual keywords, URLs, and metrics from the provided data. Do not use placeholders or invented data.
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
        model: "gpt-4o-2024-08-06",
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
            model: "gpt-4o-2024-08-06",
            messages: [
              {
                role: "system",
                content: "You are an expert in SEO and data analysis, specialized in analyzing Google Search Console data to provide meaningful insights."
              },
              {
                role: "user",
                content: prompt
              }
            ],
            temperature: 0.2,
            max_tokens: 4000,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
          }),
          signal: controller.signal
        });
        
        // Clear the timeout to avoid aborting after response is received
        clearTimeout(timeoutId);
        
        if (!openaiResponse.ok) {
          console.error('OpenAI API error:', {
            status: openaiResponse.status,
            statusText: openaiResponse.statusText
          });
          
          try {
            const errorJson = await openaiResponse.json();
            console.error('OpenAI API error details:', errorJson);
          } catch (jsonError) {
            console.error('Failed to parse OpenAI error response:', jsonError);
          }
          
          // Return fallback data if OpenAI API returns an error
          const fallbackInsights = generateFallbackInsights(siteUrl, period);
          return new Response(JSON.stringify(fallbackInsights), {
            headers: corsHeaders
          });
        }

        // Parse the OpenAI response, handle potential errors
        try {
          const openaiData = await openaiResponse.json();
          console.log('OpenAI API response received:', {
            hasChoices: !!openaiData.choices,
            choicesLength: openaiData.choices ? openaiData.choices.length : 0,
            firstChoiceHasContent: openaiData.choices && openaiData.choices.length > 0 && !!openaiData.choices[0].message
          });
          
          // Extract the content from the response
          if (!openaiData.choices || !openaiData.choices.length || !openaiData.choices[0].message) {
            console.error('Unexpected OpenAI response format:', openaiData);
            
            // Return fallback insights if the response is not in the expected format
            const fallbackInsights = generateFallbackInsights(siteUrl, period);
            return new Response(JSON.stringify(fallbackInsights), {
              headers: corsHeaders
            });
          }
          
          // Extract the raw content from the response
          const rawContent = openaiData.choices[0].message.content;
          
          // Attempt to parse the content as JSON
          let parsedContent;
          try {
            // Try to find and extract a JSON object from the content
            const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              parsedContent = JSON.parse(jsonMatch[0]);
              
              // Validate that the parsed content has the required fields
              if (!parsedContent.raw_data || !parsedContent.ai_analysis) {
                console.error('Parsed content missing required fields:', parsedContent);
                
                // Return fallback insights if the content doesn't have the required fields
                const fallbackInsights = generateFallbackInsights(siteUrl, period);
                return new Response(JSON.stringify(fallbackInsights), {
                  headers: corsHeaders
                });
              }
              
              // Add success flag to the response
              parsedContent.success = true;
              
              // Store the insights in the database and return the response
              generatedInsights = parsedContent;
            } else {
              console.error('Failed to extract JSON from OpenAI response content:', rawContent);
              
              // Return fallback insights if we can't extract JSON from the response
              const fallbackInsights = generateFallbackInsights(siteUrl, period);
              return new Response(JSON.stringify(fallbackInsights), {
                headers: corsHeaders
              });
            }
          } catch (parseError) {
            console.error('Failed to parse OpenAI response content as JSON:', parseError);
            console.log('Raw content that failed to parse:', rawContent);
            
            // Return fallback insights if we can't parse the content as JSON
            const fallbackInsights = generateFallbackInsights(siteUrl, period);
            return new Response(JSON.stringify(fallbackInsights), {
              headers: corsHeaders
            });
          }
          
          // Cache the insights for future use
          if (generatedInsights) {
            const stringifiedContent = JSON.stringify(generatedInsights);
            try {
              await env.DB.prepare(
                `INSERT INTO insights (user_id, site_url, date, type, content)
                VALUES (?, ?, ?, 'overall', ?)`
              ).bind(userId, siteUrl, today, stringifiedContent).run();
              
              // Deduct one credit from the user's account
              await env.DB.prepare(
                'UPDATE users SET credits = credits - 1 WHERE id = ? AND credits > 0'
              ).bind(userId).run();
              
              console.log('Successfully stored insights in database for future use');
            } catch (dbError) {
              console.error('Error storing insights in database:', dbError);
              // Continue anyway, since we already have the insights
            }
          }
          
          return new Response(JSON.stringify(generatedInsights), {
            headers: corsHeaders
          });
        } catch (parseError) {
          console.error('Error parsing OpenAI API response:', parseError);
          
          // Return fallback insights if we can't parse the response
          const fallbackInsights = generateFallbackInsights(siteUrl, period);
          return new Response(JSON.stringify(fallbackInsights), {
            headers: corsHeaders
          });
        }
      } catch (fetchError) {
        console.error('Error fetching from OpenAI API:', fetchError);
        
        // Handle timeout errors specifically
        if (fetchError.name === 'AbortError') {
          console.log('OpenAI API request timed out');
          // Return a timeout-specific error response
          const fallbackInsights = generateFallbackInsights(siteUrl, period);
          fallbackInsights.ai_analysis.summary = "The request timed out. Please try again with a shorter date range or fewer metrics.";
          return new Response(JSON.stringify(fallbackInsights), {
            headers: corsHeaders
          });
        }
        
        // Return fallback insights for other fetch errors
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
  // Create a fallback insights object when OpenAI API fails
  return {
    success: true,
    raw_data: {
      metrics: {
        clicks: [120, 115, 130, 125, 140],
        impressions: [1500, 1450, 1600, 1550, 1700],
        ctr: [0.08, 0.079, 0.081, 0.081, 0.082],
        position: [22.5, 22.8, 22.3, 22.1, 21.9]
      },
      top_keywords: [
        { name: "example keyword 1", metrics: { clicks: 35, impressions: 420, ctr: 0.083, position: 18.2 } },
        { name: "example keyword 2", metrics: { clicks: 28, impressions: 350, ctr: 0.08, position: 20.4 } },
        { name: "example keyword 3", metrics: { clicks: 22, impressions: 310, ctr: 0.071, position: 21.7 } }
      ],
      top_pages: [
        { name: "/example-page-1", metrics: { clicks: 45, impressions: 520, ctr: 0.087, position: 17.3 } },
        { name: "/example-page-2", metrics: { clicks: 32, impressions: 410, ctr: 0.078, position: 19.8 } },
        { name: "/example-page-3", metrics: { clicks: 25, impressions: 380, ctr: 0.066, position: 22.1 } }
      ],
      time_period: period
    },
    ai_analysis: {
      summary: "This is a fallback analysis using placeholder data. Please try again later when our AI service is available.",
      
      performance: {
        trend: "stable",
        changePercent: "+4.2%",
        timePeriod: period,
        keyMetricChanges: [
          { metric: "clicks", change: "+4.2%", interpretation: "Slight increase in overall clicks (placeholder data)" },
          { metric: "impressions", change: "+3.8%", interpretation: "Slight increase in impressions (placeholder data)" },
          { metric: "ctr", change: "+0.5%", interpretation: "CTR remains relatively stable (placeholder data)" },
          { metric: "position", change: "+1.1%", interpretation: "Slight improvement in average position (placeholder data)" }
        ],
        details: "This is placeholder performance data. The actual system will provide detailed analysis of your site's performance based on real Google Search Console data."
      },
      
      topFindings: [
        {
          title: "Placeholder Finding",
          description: "This is a placeholder finding. The actual system will identify real insights based on your site's performance data.",
          impactLevel: "medium",
          dataPoints: [
            "Placeholder data point 1 - in the actual system, this will reference real metrics",
            "Placeholder data point 2 - in the actual system, this will reference real metrics"
          ]
        }
      ],
      
      opportunities: [
        {
          title: "Placeholder Opportunity",
          description: "This is a placeholder opportunity. The actual system will identify real opportunities based on your site's data.",
          estimatedImpact: "Potentially +5-10% improvement",
          difficulty: "moderate",
          timeFrame: "short-term"
        }
      ],
      
      recommendations: [
        {
          title: "Placeholder Recommendation",
          description: "This is a placeholder recommendation. The actual system will provide tailored recommendations based on your site's specific data and performance.",
          priority: "medium",
          expectedOutcome: "Improved visibility and traffic when implemented correctly",
          implementationSteps: [
            "Step 1 would go here in the actual system",
            "Step 2 would go here in the actual system",
            "Step 3 would go here in the actual system"
          ]
        }
      ],
      
      keywordInsights: {
        risingKeywords: [],
        decliningKeywords: [],
        missedOpportunities: [],
        analysis: "Keyword insights will be provided when the AI service is available."
      }
    }
  };
}

// Helper function to generate mock insights for testing
function generateMockInsights(siteUrl, period) {
  // Generated mock insights for development and testing
  return {
    success: true,
    raw_data: {
      metrics: {
        clicks: [358, 342, 385, 412, 437, 463],
        impressions: [9240, 8970, 9350, 9820, 10150, 10680],
        ctr: [0.0388, 0.0381, 0.0412, 0.0419, 0.0430, 0.0433],
        position: [18.3, 18.5, 18.1, 17.8, 17.5, 17.2]
      },
      top_keywords: [
        { name: "responsive web design tutorial", metrics: { clicks: 87, impressions: 1340, ctr: 0.065, position: 12.3 } },
        { name: "css grid examples", metrics: { clicks: 76, impressions: 1290, ctr: 0.059, position: 13.8 } },
        { name: "javascript best practices 2023", metrics: { clicks: 65, impressions: 1150, ctr: 0.057, position: 14.2 } },
        { name: "react state management", metrics: { clicks: 58, impressions: 1050, ctr: 0.055, position: 15.6 } },
        { name: "frontend developer portfolio", metrics: { clicks: 42, impressions: 920, ctr: 0.046, position: 16.3 } }
      ],
      top_pages: [
        { name: "/tutorials/responsive-design", metrics: { clicks: 124, impressions: 2250, ctr: 0.055, position: 11.8 } },
        { name: "/blog/css-grid-layout", metrics: { clicks: 98, impressions: 1950, ctr: 0.050, position: 14.2 } },
        { name: "/resources/javascript-guide", metrics: { clicks: 87, impressions: 1820, ctr: 0.048, position: 15.3 } },
        { name: "/tutorials/react-hooks", metrics: { clicks: 76, impressions: 1650, ctr: 0.046, position: 16.7 } },
        { name: "/portfolio-examples", metrics: { clicks: 52, impressions: 1210, ctr: 0.043, position: 18.4 } }
      ],
      time_period: period
    },
    ai_analysis: {
      summary: `Your site ${siteUrl} shows positive growth during ${period} with a 29.3% increase in clicks and 15.6% increase in impressions. The overall search visibility is improving with average position moving from 18.3 to 17.2.`,
      
      performance: {
        trend: "up",
        changePercent: "+29.3%",
        timePeriod: period,
        keyMetricChanges: [
          { metric: "clicks", change: "+29.3%", interpretation: "Significant increase in user engagement, suggesting improved relevance or visibility" },
          { metric: "impressions", change: "+15.6%", interpretation: "Growing search visibility across targeted keywords" },
          { metric: "ctr", change: "+11.6%", interpretation: "Improving click-through rate indicates better alignment between search intent and page content" },
          { metric: "position", change: "+6.0%", interpretation: "Steadily improving rankings across tracked keywords" }
        ],
        details: "Performance shows consistent improvement across all key metrics. The most significant growth is in clicks, which have increased by 29.3% over the period. This suggests that your content is not only appearing more frequently in search results (15.6% more impressions) but also becoming more relevant to searchers as indicated by the improved CTR. The average position improvement from 18.3 to 17.2 is helping drive these positive trends."
      },
      
      topFindings: [
        {
          title: "Tutorial Content Driving Engagement",
          description: "Your tutorial pages are the highest performing content, with the responsive design tutorial generating 124 clicks at a 5.5% CTR.",
          impactLevel: "high",
          dataPoints: [
            "/tutorials/responsive-design received 124 clicks with 2,250 impressions",
            "Tutorial content averages a 5.1% CTR compared to 4.3% site average",
            "3 of your top 5 performing pages are tutorials"
          ]
        },
        {
          title: "CSS Grid Content Shows Promising Growth",
          description: "Your CSS grid related content has seen a 32% increase in clicks during this period, suggesting growing interest in this topic.",
          impactLevel: "medium",
          dataPoints: [
            "'css grid examples' keyword receives 76 clicks from 1,290 impressions",
            "/blog/css-grid-layout page is your second highest performer with 98 clicks",
            "Average position for CSS grid content is 14.0, better than site average"
          ]
        },
        {
          title: "Mobile-Related Queries Underperforming",
          description: "Despite strong performance in responsive design, specific mobile-related queries have a below-average CTR of 3.2% compared to site average of 4.3%.",
          impactLevel: "medium",
          dataPoints: [
            "Mobile-specific keywords average position 19.2 vs. site average of 17.2",
            "Mobile content pages average 3.2% CTR vs. site average of 4.3%",
            "Mobile-related impressions are growing but clicks are not keeping pace"
          ]
        }
      ],
      
      opportunities: [
        {
          title: "Expand JavaScript Best Practices Content",
          description: "The 'javascript best practices 2023' keyword is performing well, but traffic could be increased with expanded and more in-depth content.",
          estimatedImpact: "+30-40% more clicks for JavaScript content",
          difficulty: "moderate",
          timeFrame: "short-term"
        },
        {
          title: "Improve Mobile Content CTR",
          description: "Optimize titles and meta descriptions for mobile-specific content to improve the below-average CTR for these pages.",
          estimatedImpact: "+20-25% CTR improvement for mobile content",
          difficulty: "easy",
          timeFrame: "immediate"
        },
        {
          title: "Create React State Management Series",
          description: "Based on the performance of 'react state management' keyword, developing a comprehensive series on this topic could capture more search traffic.",
          estimatedImpact: "+50-60% more traffic for React content",
          difficulty: "complex",
          timeFrame: "long-term"
        }
      ],
      
      recommendations: [
        {
          title: "Update and Expand CSS Grid Content",
          description: "Your CSS grid content is performing well, but could be refreshed with new examples and practical applications to capture more search interest.",
          priority: "high",
          expectedOutcome: "Increase clicks by 30-40% for CSS grid related keywords",
          implementationSteps: [
            "Update existing CSS grid examples with current best practices",
            "Add a section on CSS grid for responsive layouts without media queries",
            "Create comparison examples between Flexbox and Grid for common layouts",
            "Add interactive examples that users can experiment with"
          ]
        },
        {
          title: "Optimize Mobile Content Meta Descriptions",
          description: "Rewrite meta descriptions for mobile-related content to better match search intent and improve CTR.",
          priority: "medium",
          expectedOutcome: "Improve CTR by 15-20% for mobile content pages",
          implementationSteps: [
            "Audit current meta descriptions for all mobile-related content",
            "Research top-performing competitors' meta descriptions for similar content",
            "Rewrite meta descriptions to include key phrases from the search queries",
            "Add value propositions in meta descriptions (e.g., 'with code examples')"
          ]
        },
        {
          title: "Create Content Cluster Around React State Management",
          description: "Develop a comprehensive guide to React state management approaches with individual in-depth articles on each method.",
          priority: "medium",
          expectedOutcome: "Establish topical authority and increase traffic by 50% for React topics",
          implementationSteps: [
            "Create cornerstone content comparing all state management approaches",
            "Develop individual tutorials for Redux, Context API, useState/useReducer, and Recoil",
            "Include practical examples showing migration between different approaches",
            "Implement proper internal linking between all related content"
          ]
        }
      ],
      
      keywordInsights: {
        risingKeywords: [
          "javascript best practices 2023",
          "react state management",
          "css grid examples",
          "frontend developer portfolio"
        ],
        decliningKeywords: [
          "jquery tutorials",
          "css floats",
          "bootstrap 4 templates"
        ],
        missedOpportunities: [
          "typescript tutorials",
          "nextjs examples",
          "tailwind vs bootstrap"
        ],
        analysis: "Your content is performing well for current frontend development topics like CSS Grid, React, and JavaScript best practices. There appears to be a shift in interest from older technologies (jQuery, CSS floats) to more modern approaches. Consider creating content around TypeScript, Next.js, and Tailwind CSS, which are generating impressions but you currently don't have optimized content for these queries."
      }
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