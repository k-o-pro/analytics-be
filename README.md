# Search Console Analytics Backend

A robust serverless API built on Cloudflare Workers that powers the Search Console Analytics platform, providing secure access to Google Search Console data and AI-powered insights.

## Overview

The Search Console Analytics backend serves as the API layer for the analytics platform, handling authentication, data retrieval, caching, rate limiting, and AI processing. It's designed to be scalable, secure, and highly performant using Cloudflare's edge infrastructure.

## Key Features

- **Serverless Architecture**: Built on Cloudflare Workers for global distribution and high availability
- **OAuth Integration**: Secure authentication with Google Search Console API
- **Advanced Caching**: Edge caching for improved performance and reduced API costs
- **Rate Limiting**: Intelligent rate limiting to prevent API abuse
- **Robust Error Handling**: Comprehensive error handling with detailed error responses
- **AI Insights Generation**: Processing of GSC data to generate actionable insights
- **Database Integration**: Cloudflare D1 (SQLite) for persistent data storage

## Technology Stack

- **Runtime**: Cloudflare Workers (JavaScript)
- **Router**: itty-router for request routing
- **Database**: Cloudflare D1 (SQLite-compatible)
- **Storage**: Cloudflare KV for token and cache storage
- **Authentication**: JWT for API authentication
- **Validation**: Zod for request validation
- **CORS**: itty-cors for cross-origin resource sharing

## Project Structure

```
/src
  /services         - External service integrations
  /utils
    cache.js        - Caching utilities
    errors.js       - Error handling system
    rateLimiter.js  - Rate limiting implementation
  auth.js           - Authentication endpoints and logic
  credits.js        - User credits management
  gsc.js            - Google Search Console API integration
  index.js          - Main application entry point
  insights.js       - AI insights generation
  schema.sql        - Database schema
```

## Recent Improvements

### Enhanced Insights Structure
- Redesigned insights response format to clearly separate raw data from AI analysis
- Structured raw_data section to include actual metrics from Google Search Console
- Enhanced AI analysis with detailed performance trends, findings, and recommendations
- Added robust error handling to always return valid, structured responses
- Implemented fallback system for graceful degradation when AI service is unavailable

### Enhanced Error Handling
- Implemented standardized error response structure
- Created custom error classes for different error types
- Added centralized error handling middleware
- Improved error logging and client feedback

### Robust Rate Limiting
- Implemented token bucket algorithm for rate limiting
- Added per-endpoint and per-user rate limits
- Created clear rate limit exceeded responses
- Stored rate limit state in Cloudflare KV

### Performance Optimization
- Implemented multi-level caching strategy
- Added automatic cache invalidation for fresh data
- Optimized database queries for faster response times
- Implemented parallel processing for batch operations

## API Endpoints

### Authentication
- `POST /auth/login` - User login with email/password
- `POST /auth/register` - New user registration
- `POST /auth/google` - Initiate Google OAuth flow
- `POST /auth/callback` - Process OAuth callback
- `POST /auth/refresh` - Refresh access token
- `POST /auth/logout` - Invalidate current token

### Google Search Console
- `GET /gsc/properties` - List available GSC properties
- `POST /gsc/data` - Retrieve GSC metrics data
- `GET /gsc/top-pages` - Get top-performing pages
- `GET /gsc/keywords` - Get top keywords

### Insights
- `POST /insights/generate` - Generate AI-powered site insights
- `POST /insights/page/:url` - Generate page-specific insights
- `GET /insights/history` - Retrieve previously generated insights

### User Management
- `GET /credits` - Get current user credit balance
- `POST /credits/use` - Use credits for premium features

## Setup & Installation

### Prerequisites

- Node.js (v16+) and npm
- Cloudflare account with Workers and D1 enabled
- Google Cloud Platform account with Search Console API enabled
- Wrangler CLI

### Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/analytics-be.git
   cd analytics-be
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   
   Create `.env.development` and `.env.production` files:
   ```
   FRONTEND_URL=http://localhost:3000
   JWT_SECRET=your_jwt_secret
   ```

4. **Run development server**
   ```bash
   npm run dev
   ```

## Deployment

1. **Authenticate with Cloudflare**
   ```bash
   npx wrangler login
   ```

2. **Deploy to Cloudflare**
   ```bash
   npm run deploy
   ```

## Error Handling System

The backend implements a comprehensive error handling system with the following error types:

- **AuthError**: Authentication and authorization failures
- **ValidationError**: Invalid request data
- **RateLimitError**: Rate limit exceeded errors
- **APIError**: External API errors (e.g., GSC API)
- **DatabaseError**: Database operation failures
- **NotFoundError**: Resource not found errors

Each error type provides specific status codes, error messages, and optional additional details to help with debugging and user feedback.

## Rate Limiting

The rate limiting system uses a token bucket algorithm with the following features:

- Global rate limits to protect the entire API
- Endpoint-specific rate limits for sensitive operations
- User-specific rate limits based on subscription tier
- Automatic retry-after headers for client guidance

## Caching Strategy

The backend employs a multi-level caching strategy:

1. **In-memory cache**: For frequently accessed, short-lived data
2. **KV storage**: For persistent caching of API responses
3. **Database cache**: For long-term storage of processed data

Cache invalidation occurs automatically based on time-to-live (TTL) values or through explicit invalidation during data updates.

## Security Considerations

- JWT tokens with short expiration for API authentication
- Secure storage of refresh tokens in KV store
- Input validation for all API endpoints using Zod
- CORS restrictions to approved domains
- Rate limiting to prevent abuse
- Encrypted storage of sensitive data

## Troubleshooting

### Common Issues

1. **Authentication Errors**
   - Check JWT secret configuration
   - Verify Google OAuth credentials
   - Ensure tokens haven't expired

2. **Database Connection Issues**
   - Verify D1 database bindings in wrangler.toml
   - Check database migration status

3. **Rate Limit Errors**
   - Implement backoff strategy in clients
   - Check rate limit configuration

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Google Search Console API documentation
- Cloudflare Workers and D1 documentation
- The open-source community for the libraries used