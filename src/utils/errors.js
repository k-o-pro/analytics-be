// Custom error classes and error handling utilities

/**
 * Base API Error class
 */
class APIError extends Error {
    constructor(message, status = 500, code = 'INTERNAL_ERROR', details = null) {
        super(message);
        this.name = 'APIError';
        this.status = status;
        this.code = code;
        this.details = details;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Authentication related errors
 */
export class AuthError extends APIError {
    constructor(message, details = null) {
        super(message, 401, 'AUTH_ERROR', details);
        this.name = 'AuthError';
    }
}

/**
 * Rate limit errors
 */
export class RateLimitError extends APIError {
    constructor(message, remaining, reset, details = null) {
        super(message, 429, 'RATE_LIMIT_ERROR', details);
        this.name = 'RateLimitError';
        this.remaining = remaining;
        this.reset = reset;
    }
}

/**
 * Validation errors
 */
export class ValidationError extends APIError {
    constructor(message, details = null) {
        super(message, 400, 'VALIDATION_ERROR', details);
        this.name = 'ValidationError';
    }
}

/**
 * Resource not found errors
 */
export class NotFoundError extends APIError {
    constructor(message, details = null) {
        super(message, 404, 'NOT_FOUND', details);
        this.name = 'NotFoundError';
    }
}

/**
 * Create a standardized error response
 * @param {Error} error - Error object
 * @param {Object} headers - Response headers
 * @returns {Response} Error response
 */
export function createErrorResponse(error, headers = {}) {
    const status = error.status || 500;
    const response = {
        success: false,
        error: error.message,
        code: error.code || 'INTERNAL_ERROR',
        details: error.details
    };

    // Add rate limit headers if present
    if (error instanceof RateLimitError) {
        headers['X-RateLimit-Remaining'] = error.remaining.toString();
        headers['X-RateLimit-Reset'] = error.reset.toString();
    }

    return new Response(JSON.stringify(response), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...headers
        }
    });
}

/**
 * Handle async errors in route handlers
 * @param {Function} handler - Route handler function
 * @returns {Function} Wrapped handler with error handling
 */
export function withErrorHandling(handler) {
    return async (request, env) => {
        try {
            return await handler(request, env);
        } catch (error) {
            console.error('Handler error:', error);
            
            // If it's already an APIError, use it as is
            if (error instanceof APIError) {
                return createErrorResponse(error);
            }
            
            // For unknown errors, wrap them in a generic APIError
            return createErrorResponse(
                new APIError(
                    'An unexpected error occurred',
                    500,
                    'INTERNAL_ERROR',
                    error.message
                )
            );
        }
    };
}

/**
 * Validate required fields in request body
 * @param {Object} body - Request body
 * @param {string[]} requiredFields - Array of required field names
 * @throws {ValidationError} If any required field is missing
 */
export function validateRequiredFields(body, requiredFields) {
    const missingFields = requiredFields.filter(field => !body[field]);
    
    if (missingFields.length > 0) {
        throw new ValidationError(
            `Missing required fields: ${missingFields.join(', ')}`,
            { missingFields }
        );
    }
}

/**
 * Create common CORS headers
 * @param {string} frontendUrl - Frontend URL
 * @returns {Object} CORS headers
 */
export function createCorsHeaders(frontendUrl) {
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': frontendUrl || 'https://analytics.k-o.pro',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Credentials': 'true'
    };
} 