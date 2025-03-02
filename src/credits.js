// Credit management functions

// Get user credits
export async function getCredits(request, env) {
    const userId = request.user.user_id;
    
    const user = await env.DB.prepare(
      'SELECT credits FROM users WHERE id = ?'
    ).bind(userId).first();
    
    return new Response(JSON.stringify({ credits: user.credits }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Use credits
  export async function useCredits(request, env) {
    const userId = request.user.user_id;
    const { amount = 1, purpose } = await request.json();
    
    // Check if user has enough credits
    const user = await env.DB.prepare(
      'SELECT credits FROM users WHERE id = ?'
    ).bind(userId).first();
    
    if (user.credits < amount) {
      return new Response(JSON.stringify({
        error: 'Insufficient credits',
        credits: user.credits
      }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Deduct credits
    await env.DB.prepare(
      'UPDATE users SET credits = credits - ? WHERE id = ?'
    ).bind(amount, userId).run();
    
    // Log credit usage
    await env.DB.prepare(
      'INSERT INTO credit_logs (user_id, amount, purpose, created_at) VALUES (?, ?, ?, ?)'
    ).bind(
      userId,
      amount,
      purpose,
      new Date().toISOString()
    ).run();
    
    return new Response(JSON.stringify({
      success: true,
      credits: user.credits - amount
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }