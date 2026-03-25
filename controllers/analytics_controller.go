package controllers

import (
	"net/http"
	"strconv"
	"time"

	"prophet-trader/services"

	"github.com/gin-gonic/gin"
)

// AnalyticsController handles performance analytics endpoints.
type AnalyticsController struct {
	analytics *services.AnalyticsService
}

// NewAnalyticsController creates a new analytics controller.
func NewAnalyticsController(analytics *services.AnalyticsService) *AnalyticsController {
	return &AnalyticsController{analytics: analytics}
}

// parseSince reads the optional ?since= query param (RFC3339) and defaults to 30 days ago.
func parseSince(c *gin.Context) time.Time {
	if s := c.Query("since"); s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			return t
		}
	}
	return time.Now().AddDate(0, -1, 0)
}

// HandleGetSummary returns aggregate performance metrics.
// GET /api/v1/analytics/summary?since=<RFC3339>
func (ac *AnalyticsController) HandleGetSummary(c *gin.Context) {
	summary, err := ac.analytics.GetTradeSummary(parseSince(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, summary)
}

// HandleGetEquityCurve returns portfolio value over time.
// GET /api/v1/analytics/equity-curve?since=<RFC3339>
func (ac *AnalyticsController) HandleGetEquityCurve(c *gin.Context) {
	points, err := ac.analytics.GetEquityCurve(parseSince(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"points": points, "count": len(points)})
}

// HandleGetBySymbol returns per-ticker performance breakdown.
// GET /api/v1/analytics/by-symbol?since=<RFC3339>
func (ac *AnalyticsController) HandleGetBySymbol(c *gin.Context) {
	stats, err := ac.analytics.GetSymbolBreakdown(parseSince(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"symbols": stats})
}

// HandleGetDrawdown returns drawdown statistics.
// GET /api/v1/analytics/drawdown
func (ac *AnalyticsController) HandleGetDrawdown(c *gin.Context) {
	stats, err := ac.analytics.GetDrawdownStats()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, stats)
}

// HandleGetTrades returns a filtered list of closed trades.
// GET /api/v1/analytics/trades?since=<RFC3339>&symbol=<sym>&limit=<n>
func (ac *AnalyticsController) HandleGetTrades(c *gin.Context) {
	since := parseSince(c)
	symbol := c.Query("symbol")
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))

	trades, err := ac.analytics.GetRecentTrades(limit, symbol, since)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"trades": trades, "count": len(trades)})
}

// HandleGetByStrategy returns per-strategy performance breakdown.
// GET /api/v1/analytics/by-strategy?since=<RFC3339>
func (ac *AnalyticsController) HandleGetByStrategy(c *gin.Context) {
	stats, err := ac.analytics.GetStrategyBreakdown(parseSince(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"strategies": stats})
}
