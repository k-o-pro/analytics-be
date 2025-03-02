// Functions to generate insights using OpenAI API
  
  // Generate overall insights
  export async function generateInsights(request, env) {
    const userId = request.user.user_id;
    const { siteUrl, period, data } = await request.json();
    
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
      return new Response('Failed to generate insights', { status: openaiResponse.status });
    }
    
    const openaiData = await openaiResponse.json();
    const generatedInsights = openaiData.choices[0].message.content;
    
    // Store insights in database
    await env.DB.prepare(
      `INSERT OR REPLACE INTO insights (user_id, site_url, date, type, content, created_at)
       VALUES (?, ?, ?, 'overall', ?, ?)`
    ).bind(
      userId,
      siteUrl,
      today,
      generatedInsights,
      new Date().toISOString()
    ).run();
    
    // Deduct credit
    await env.DB.prepare(
      'UPDATE users SET credits = credits - 1 WHERE id = ?'
    ).bind(userId).run();
    
    return new Response(generatedInsights, {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Generate page-specific insights
  export async function generatePageInsights(request, env) {
    // Similar to generateInsights, but focused on a specific page
    // ...
  }