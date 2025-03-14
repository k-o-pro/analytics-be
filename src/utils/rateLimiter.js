// Rate limiter utility for API calls

const DEFAULT_LIMIT = 100; // requests per minute
const DEFAULT_WINDOW = 60; // seconds

/**
 * Check if a request should be rate limited
 * @param {KVNamespace} kv - Cloudflare KV namespace
 * @param {string} key - Rate limit key
 * @param {number} limit - Maximum requests allowed in window
 * @param {number} window - Time window in seconds
 * @returns {Promise<{limited: boolean, remaining: number, reset: number}>}
 */
export async function checkRateLimit(kv, key, limit = DEFAULT_LIMIT, window = DEFAULT_WINDOW) {
    try {
        const now = Date.now();
        const windowKey = `${key}:${Math.floor(now / (window * 1000))}`;
        
        // Get current count for this window
        const current = await kv.get(windowKey, 'json') || { count: 0, reset: now + (window * 1000) };
        
        // If window expired, reset counter
        if (now > current.reset) {
            await kv.put(windowKey, JSON.stringify({
                count: 1,
                reset: now + (window * 1000)
            }), {
                expirationTtl: window
            });
            return {
                limited: false,
                remaining: limit - 1,
                reset: now + (window * 1000)
            };
        }
        
        // Check if limit exceeded
        if (current.count >= limit) {
            return {
                limited: true,
                remaining: 0,
                reset: current.reset
            };
        }
        
        // Increment counter
        await kv.put(windowKey, JSON.stringify({
            count: current.count + 1,
            reset: current.reset
        }), {
            expirationTtl: window
        });
        
        return {
            limited: false,
            remaining: limit - (current.count + 1),
            reset: current.reset
        };
    } catch (error) {
        console.error('Rate limit check error:', error);
        // On error, allow the request to proceed
        return {
            limited: false,
            remaining: limit,
            reset: Date.now() + (window * 1000)
        };
    }
}

/**
 * Generate a rate limit key for GSC API calls
 * @param {string} userId - User ID
 * @param {string} endpoint - API endpoint
 * @returns {string} Rate limit key
 */
export function generateGSCRateLimitKey(userId, endpoint) {
    return `rate_limit:gsc:${userId}:${endpoint}`;
}

/**
 * Create a rate limit response
 * @param {number} remaining - Remaining requests
 * @param {number} reset - Reset timestamp
 * @returns {Response} Rate limit response
 */
export function createRateLimitResponse(remaining, reset) {
    return new Response(JSON.stringify({
        success: false,
        error: 'Rate limit exceeded',
        remaining,
        reset
    }), {
        status: 429,
        headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Remaining': remaining.toString(),
            'X-RateLimit-Reset': reset.toString()
        }
    });
} 