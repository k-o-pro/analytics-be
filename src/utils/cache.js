// Cache utility functions for Cloudflare Workers

const DEFAULT_TTL = 3600; // 1 hour in seconds

/**
 * Get cached data from KV store
 * @param {KVNamespace} kv - Cloudflare KV namespace
 * @param {string} key - Cache key
 * @returns {Promise<Object|null>} Cached data or null if not found/expired
 */
export async function getCachedData(kv, key) {
    try {
        const cached = await kv.get(key, 'json');
        if (!cached) return null;

        // Check if cache is expired
        if (cached.expiresAt && Date.now() > cached.expiresAt) {
            await kv.delete(key);
            return null;
        }

        return cached.data;
    } catch (error) {
        console.error('Cache read error:', error);
        return null;
    }
}

/**
 * Set data in cache with TTL
 * @param {KVNamespace} kv - Cloudflare KV namespace
 * @param {string} key - Cache key
 * @param {Object} data - Data to cache
 * @param {number} ttl - Time to live in seconds
 * @returns {Promise<void>}
 */
export async function setCachedData(kv, key, data, ttl = DEFAULT_TTL) {
    try {
        const cacheData = {
            data,
            expiresAt: Date.now() + (ttl * 1000)
        };
        await kv.put(key, JSON.stringify(cacheData), {
            expirationTtl: ttl
        });
    } catch (error) {
        console.error('Cache write error:', error);
    }
}

/**
 * Generate a cache key for GSC data
 * @param {string} userId - User ID
 * @param {string} endpoint - API endpoint
 * @param {Object} params - Additional parameters
 * @returns {string} Cache key
 */
export function generateGSCacheKey(userId, endpoint, params = {}) {
    const paramString = Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}:${value}`)
        .join('|');
    
    return `gsc:${userId}:${endpoint}:${paramString}`;
} 