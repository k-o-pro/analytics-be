// Functions to generate insights using OpenAI API

// Generate overall insights
export async function generateInsights(request, env) {
  try {
    const userId = request.user.user_id;
    const { siteUrl, period, data } = await request.json();

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

    // Check if user has already generated insights today
    const today = new Date().toISOString().split('T')[0];
    const existingInsight = await env.DB.prepare(
      `SELECT id FROM insights 
       WHERE user_id = ? AND site_url = ? AND date = ? AND type = 'overall'`
    ).bind(userId, siteUrl, today).first();

    // If insights exist and not forced refresh, return cached version
    if (existingInsight && !request.url.includes('force=true')) {
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

    // Call OpenAI API
    const openaiResponse = await fetch(env.OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [
          { role: "system", content: "You are an SEO and website analytics expert. Provide concise, actionable insights." },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!openaiResponse.ok) {
      // Log the detailed error for debugging
      const errorText = await openaiResponse.text();
      console.error('OpenAI API error:', openaiResponse.status, errorText);
      return new Response(JSON.stringify({
        success: false,
        error: `OpenAI API error: ${openaiResponse.status}`
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Additional validation for OpenAI response
    const openaiData = await openaiResponse.json();
    if (!openaiData.choices || !openaiData.choices[0] || !openaiData.choices[0].message) {
      console.error('Invalid OpenAI response format:', openaiData);
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid response from AI service'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Parse JSON response from OpenAI or use as-is if already JSON
    let generatedInsights;
    try {
      const content = openaiData.choices[0].message.content;
      // Check if the content is already in JSON format
      if (typeof content === 'string' && content.trim().startsWith('{')) {
        generatedInsights = JSON.parse(content);
      } else {
        generatedInsights = content;
      }
    } catch (error) {
      console.error('Failed to parse OpenAI response as JSON:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to parse AI response'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

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

    // Return the insights as a proper JSON response
    return new Response(
      typeof generatedInsights === 'string' ? generatedInsights : JSON.stringify(generatedInsights), 
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
  } catch (error) {
    console.error('Error in generateInsights:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to generate insights'
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}

// Generate page-specific insights
export async function generatePageInsights(request, env) {
  // Similar to generateInsights, but focused on a specific page
  // ...
}