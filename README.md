# Search Console Analytics

A powerful web application that transforms complex Google Search Console data into actionable insights with AI-powered analysis and visualizations.

## Overview

Search Console Analytics provides a comprehensive dashboard for analyzing your website's search performance using data from Google Search Console. The application delivers intuitive visualizations, top page analysis, and AI-generated insights to help you understand and improve your site's visibility in search results.

## Features

- **Interactive Dashboard**: View key metrics (clicks, impressions, CTR, position) with performance trends
- **Top Pages Analysis**: Identify your best-performing pages and opportunities for improvement
- **AI-Powered Insights**: Generate actionable recommendations based on your search performance data
- **Multiple Properties**: Connect and manage multiple GSC properties
- **Historical Data**: Track performance over time with comparative analysis
- **Credit System**: Premium features accessible via a credit-based system

## Architecture

The application uses a decoupled architecture:

- **Frontend**: React/TypeScript single-page application (SPA) hosted on GitHub Pages
- **Backend**: Cloudflare Workers serverless API endpoints
- **Database**: Cloudflare D1 (SQLite-compatible) for data storage and retrieval
- **Authentication**: OAuth 2.0 for Google Search Console API + JWT for application users

## Setup & Installation

### Prerequisites

- Node.js (v14+) and npm
- Cloudflare account with Workers and D1 enabled
- Google Cloud Platform account with Search Console API enabled
- GitHub account for deploying the frontend

### Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/search-console-analytics.git
   cd search-console-analytics
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   
   Create a `.env` file in the project root:
   ```
   REACT_APP_API_URL=http://localhost:8787
   REACT_APP_GOOGLE_CLIENT_ID=your_google_client_id
   ```

4. **Run frontend development server**
   ```bash
   npm start
   ```

5. **Run backend development server**
   ```bash
   npx wrangler dev
   ```

### Cloudflare Workers Setup

1. **Install Wrangler CLI globally**
   ```bash
   npm install -g wrangler
   ```

2. **Authenticate with Cloudflare**
   ```bash
   wrangler login
   ```

3. **Create D1 database**
   ```bash
   wrangler d1 create search-analytics-db
   ```

4. **Apply database migrations**
   ```bash
   wrangler d1 execute search-analytics-db --file=./src/schema.sql
   ```

5. **Create KV namespace for token storage**
   ```bash
   wrangler kv:namespace create AUTH_STORE
   wrangler kv:namespace create AUTH_STORE --preview
   ```

6. **Update wrangler.toml with your IDs**
   
   Edit the `wrangler.toml` file and replace placeholder IDs with the ones generated from the commands above:
   ```toml
   # Add KV binding for token storage
   [[kv_namespaces]]
   binding = "AUTH_STORE"
   id = "analytics-be"
   preview_id = "64f21dad93ce4636bdc4daacd1f275bd"

   # Add D1 database binding
   [[d1_databases]]
   binding = "DB"
   database_name = "analytics-be"
   database_id = "165cb9e2-49fb-40ee-b02d-58e2c5e072bb"
   ```

7. **Set up secrets**
   ```bash
   wrangler secret put OPENAI_API_KEY
   wrangler secret put JWT_SECRET
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   ```

8. **Deploy the worker**
   ```bash
   wrangler publish
   ```

### GitHub Pages Deployment

1. **Update homepage in package.json**
   
   Edit `package.json` and set the homepage to your domain:
   ```json
   {
     "homepage": "https://yourdomain.com"
   }
   ```

2. **Build and deploy**
   ```bash
   npm run deploy
   ```

3. **Set up GitHub Pages**
   
   In your GitHub repository settings:
   - Go to Pages section
   - Select the `gh-pages` branch
   - Set the custom domain if you have one
   - Enable HTTPS

4. **Set up environment variables in GitHub Actions**
   
   Create a new GitHub Actions workflow file in `.github/workflows/deploy.yml`:
   ```yaml
   name: Deploy to GitHub Pages

   on:
     push:
       branches: [main]

   jobs:
     build-and-deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v2
         - name: Install dependencies
           run: npm ci
         - name: Build
           run: npm run build
           env:
             REACT_APP_API_URL: https://api.yourdomain.com
             REACT_APP_GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}
         - name: Deploy
           uses: JamesIves/github-pages-deploy-action@4.1.5
           with:
             branch: gh-pages
             folder: build
   ```

## API Endpoints

The application exposes the following API endpoints:

### Authentication
- `POST /auth/login` - User login
- `POST /auth/register` - User registration
- `POST /auth/callback` - OAuth callback
- `POST /auth/refresh` - Refresh token

### Google Search Console
- `GET /gsc/properties` - Get available GSC properties
- `POST /gsc/data` - Retrieve GSC metrics data
- `GET /gsc/top-pages` - Get top pages performance

### Insights
- `POST /insights/generate` - Generate overall site insights
- `POST /insights/page/:url` - Generate page-specific insights

### User Management
- `GET /credits` - Get user credits
- `POST /credits/use` - Use credits for premium features

## Data Structure

### Cloudflare D1 Schema

```sql
-- Users table
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  last_login TEXT,
  credits INTEGER DEFAULT 5,
  gsc_refresh_token TEXT,
  gsc_connected INTEGER DEFAULT 0
);

-- GSC data storage
CREATE TABLE gsc_data (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  site_url TEXT NOT NULL,
  date_range TEXT NOT NULL,
  dimensions TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- Insights table
CREATE TABLE insights (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  site_url TEXT NOT NULL,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- Credit usage logs
CREATE TABLE credit_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

-- User properties (GSC sites)
CREATE TABLE user_properties (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  site_url TEXT NOT NULL,
  display_name TEXT,
  added_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);
```

## Frontend Structure

```
/src
  /components
    /auth        - Authentication components
    /dashboard   - Dashboard layout and components
    /layout      - Layout components
    /visualizations - Charts and data visualization
  /contexts
    AuthContext.tsx - Authentication context
  /hooks         - Custom hooks
  /pages         - Main application pages
  /services      - API service modules
  /types         - TypeScript type definitions
  /utils         - Utility functions
```

## OAuth Configuration

1. **Create OAuth Client ID in Google Cloud Console**
   - Go to https://console.cloud.google.com
   - Create a new project or use an existing one
   - Enable the Google Search Console API
   - Create OAuth 2.0 credentials
   - Add authorized redirect URIs:
     - `https://yourdomain.com/oauth-callback` (production)
     - `http://localhost:3000/oauth-callback` (development)

2. **Set Client ID and Secret**
   - Add to frontend environment variables
   - Add as secrets to Cloudflare Workers

## Security Considerations

- CSRF tokens for form submissions
- JWT tokens with short expiration
- Encrypted storage of refresh tokens
- CORS restrictions
- Rate limiting for API endpoints
- Input sanitization

## Credits System

The application includes a credit system for premium features:

- Each user gets 10 credits on signup
- Credits are consumed for:
  - Analysis beyond top 10 pages (1 credit per page)
  - AI insights generation (3 credits per advanced analysis)
  - Historical data beyond 90 days (2 credits per additional month)

## Troubleshooting

### Common Issues

1. **API Connection Failures**
   - Check if Cloudflare Worker is deployed
   - Verify CORS configuration in `wrangler.toml`
   - Check API URL in environment variables

2. **OAuth Issues**
   - Verify redirect URIs are correctly set
   - Check Google Cloud Console API access
   - Ensure scopes are properly configured

3. **Data Not Loading**
   - Check browser console for errors
   - Verify GSC connection is active
   - Check if user has appropriate permissions

### Developer Tools

- React Developer Tools for component debugging
- Network tab in browser DevTools for API requests
- Wrangler logs for backend issues

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Google Search Console API documentation
- Cloudflare Workers and D1 documentation
- React and Material UI teams
- OpenAI for the AI insights engine