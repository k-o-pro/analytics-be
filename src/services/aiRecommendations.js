import { APIError } from '../utils/errors.js';

/**
 * Analyze GSC data and generate recommendations
 * @param {Object} data - GSC data
 * @param {Object} options - Analysis options
 * @returns {Object} Recommendations
 */
export async function analyzeGSCData(data, options = {}) {
    try {
        const {
            rows = [],
            dimensions = ['query', 'page'],
            dateRange = { startDate: '', endDate: '' }
        } = data;

        const recommendations = {
            performance: [],
            opportunities: [],
            issues: [],
            suggestions: []
        };

        // Analyze performance trends
        const performanceAnalysis = analyzePerformance(rows, dimensions);
        recommendations.performance.push(...performanceAnalysis);

        // Identify opportunities
        const opportunities = identifyOpportunities(rows, dimensions);
        recommendations.opportunities.push(...opportunities);

        // Detect issues
        const issues = detectIssues(rows, dimensions);
        recommendations.issues.push(...issues);

        // Generate suggestions
        const suggestions = generateSuggestions(performanceAnalysis, opportunities, issues);
        recommendations.suggestions.push(...suggestions);

        return recommendations;
    } catch (error) {
        throw new APIError(
            'Failed to analyze GSC data',
            500,
            'AI_ANALYSIS_ERROR',
            { error: error.message }
        );
    }
}

/**
 * Analyze performance trends
 * @param {Array} rows - GSC data rows
 * @param {Array} dimensions - Dimensions used in the data
 * @returns {Array} Performance analysis
 */
function analyzePerformance(rows, dimensions) {
    const analysis = [];
    
    // Calculate average metrics
    const metrics = rows.reduce((acc, row) => {
        acc.clicks += row.clicks;
        acc.impressions += row.impressions;
        acc.ctr += row.ctr;
        acc.position += row.position;
        return acc;
    }, { clicks: 0, impressions: 0, ctr: 0, position: 0 });

    const avgCtr = metrics.ctr / rows.length;
    const avgPosition = metrics.position / rows.length;

    // Analyze CTR trends
    if (avgCtr < 0.02) {
        analysis.push({
            type: 'ctr',
            severity: 'high',
            message: 'Low average CTR detected. Consider improving meta descriptions and titles.',
            metrics: { current: avgCtr, target: 0.03 }
        });
    }

    // Analyze position trends
    if (avgPosition > 10) {
        analysis.push({
            type: 'position',
            severity: 'medium',
            message: 'Average position is above 10. Focus on improving content quality and relevance.',
            metrics: { current: avgPosition, target: 5 }
        });
    }

    return analysis;
}

/**
 * Identify opportunities for improvement
 * @param {Array} rows - GSC data rows
 * @param {Array} dimensions - Dimensions used in the data
 * @returns {Array} Opportunities
 */
function identifyOpportunities(rows, dimensions) {
    const opportunities = [];

    // Find high-impression, low-CTR queries
    const highImpressionQueries = rows
        .filter(row => row.impressions > 1000 && row.ctr < 0.02)
        .map(row => ({
            query: row.keys[0],
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position
        }));

    if (highImpressionQueries.length > 0) {
        opportunities.push({
            type: 'ctr_improvement',
            severity: 'high',
            message: 'Found queries with high impressions but low CTR',
            data: highImpressionQueries.slice(0, 5)
        });
    }

    // Find position 11-20 queries with good CTR
    const nearTopQueries = rows
        .filter(row => row.position > 10 && row.position <= 20 && row.ctr > 0.03)
        .map(row => ({
            query: row.keys[0],
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position
        }));

    if (nearTopQueries.length > 0) {
        opportunities.push({
            type: 'position_improvement',
            severity: 'medium',
            message: 'Found queries with good CTR but ranking 11-20',
            data: nearTopQueries.slice(0, 5)
        });
    }

    return opportunities;
}

/**
 * Detect potential issues
 * @param {Array} rows - GSC data rows
 * @param {Array} dimensions - Dimensions used in the data
 * @returns {Array} Issues
 */
function detectIssues(rows, dimensions) {
    const issues = [];

    // Check for significant drops in impressions
    const sortedRows = [...rows].sort((a, b) => b.impressions - a.impressions);
    const topQueries = sortedRows.slice(0, 10);
    
    const significantDrops = topQueries.filter(row => 
        row.impressions < 100 && row.clicks > 0
    );

    if (significantDrops.length > 0) {
        issues.push({
            type: 'impression_drop',
            severity: 'high',
            message: 'Detected significant drops in impressions for previously performing queries',
            data: significantDrops
        });
    }

    // Check for high bounce rate indicators
    const highPositionQueries = rows.filter(row => 
        row.position > 15 && row.ctr > 0.05
    );

    if (highPositionQueries.length > 0) {
        issues.push({
            type: 'content_relevance',
            severity: 'medium',
            message: 'Some queries show high CTR despite poor ranking, suggesting content relevance issues',
            data: highPositionQueries.slice(0, 5)
        });
    }

    return issues;
}

/**
 * Generate actionable suggestions
 * @param {Array} performance - Performance analysis
 * @param {Array} opportunities - Opportunities
 * @param {Array} issues - Issues
 * @returns {Array} Suggestions
 */
function generateSuggestions(performance, opportunities, issues) {
    const suggestions = [];

    // Generate suggestions based on performance analysis
    performance.forEach(analysis => {
        if (analysis.type === 'ctr' && analysis.severity === 'high') {
            suggestions.push({
                type: 'content',
                priority: 'high',
                message: 'Improve meta descriptions and titles for better CTR',
                action: 'Review and optimize meta tags for pages with low CTR'
            });
        }
        if (analysis.type === 'position' && analysis.severity === 'medium') {
            suggestions.push({
                type: 'seo',
                priority: 'medium',
                message: 'Focus on content quality and relevance improvements',
                action: 'Review content quality and update based on user intent'
            });
        }
    });

    // Generate suggestions based on opportunities
    opportunities.forEach(opportunity => {
        if (opportunity.type === 'ctr_improvement') {
            suggestions.push({
                type: 'optimization',
                priority: 'high',
                message: 'Optimize content for high-impression, low-CTR queries',
                action: 'Review and improve content for identified queries'
            });
        }
        if (opportunity.type === 'position_improvement') {
            suggestions.push({
                type: 'seo',
                priority: 'medium',
                message: 'Improve ranking for queries with good CTR',
                action: 'Enhance content and technical SEO for identified queries'
            });
        }
    });

    // Generate suggestions based on issues
    issues.forEach(issue => {
        if (issue.type === 'impression_drop') {
            suggestions.push({
                type: 'monitoring',
                priority: 'high',
                message: 'Investigate causes of impression drops',
                action: 'Review recent changes and technical issues'
            });
        }
        if (issue.type === 'content_relevance') {
            suggestions.push({
                type: 'content',
                priority: 'medium',
                message: 'Improve content relevance for identified queries',
                action: 'Update content to better match user intent'
            });
        }
    });

    return suggestions;
} 