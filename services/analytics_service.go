package services

import (
	"math"
	"time"

	"prophet-trader/models"

	"gorm.io/gorm"
)

// AnalyticsService computes performance metrics from the SQLite database.
type AnalyticsService struct {
	db *gorm.DB
}

// NewAnalyticsService creates a new analytics service.
func NewAnalyticsService(db *gorm.DB) *AnalyticsService {
	return &AnalyticsService{db: db}
}

// TradeSummary holds aggregate performance metrics.
type TradeSummary struct {
	TotalTrades    int     `json:"total_trades"`
	WinningTrades  int     `json:"winning_trades"`
	LosingTrades   int     `json:"losing_trades"`
	WinRate        float64 `json:"win_rate"`
	TotalPnL       float64 `json:"total_pnl"`
	TotalPnLPct    float64 `json:"total_pnl_pct"`
	AvgWin         float64 `json:"avg_win"`
	AvgLoss        float64 `json:"avg_loss"`
	ProfitFactor   float64 `json:"profit_factor"`
	AvgDuration    float64 `json:"avg_duration_hours"`
	BestTrade      float64 `json:"best_trade"`
	WorstTrade     float64 `json:"worst_trade"`
	Since          string  `json:"since"`
}

// EquityPoint holds a single point in the equity curve.
type EquityPoint struct {
	Time  time.Time `json:"time"`
	Value float64   `json:"value"`
}

// SymbolStat holds per-symbol performance.
type SymbolStat struct {
	Symbol   string  `json:"symbol"`
	Trades   int     `json:"trades"`
	WinRate  float64 `json:"win_rate"`
	TotalPnL float64 `json:"total_pnl"`
	AvgPnL   float64 `json:"avg_pnl"`
}

// DrawdownStats holds drawdown metrics.
type DrawdownStats struct {
	MaxDrawdownPct     float64    `json:"max_drawdown_pct"`
	CurrentDrawdownPct float64    `json:"current_drawdown_pct"`
	PeakValue          float64    `json:"peak_value"`
	CurrentValue       float64    `json:"current_value"`
	PeakTime           *time.Time `json:"peak_time"`
}

// StrategyStat holds per-strategy performance.
type StrategyStat struct {
	Strategy string  `json:"strategy"`
	Trades   int     `json:"trades"`
	WinRate  float64 `json:"win_rate"`
	TotalPnL float64 `json:"total_pnl"`
	AvgPnL   float64 `json:"avg_pnl"`
}

// TradeDetail holds a single closed trade with full detail.
type TradeDetail struct {
	ID           uint      `json:"id"`
	Symbol       string    `json:"symbol"`
	Side         string    `json:"side"`
	EntryPrice   float64   `json:"entry_price"`
	ExitPrice    float64   `json:"exit_price"`
	Qty          float64   `json:"qty"`
	PnL          float64   `json:"pnl"`
	PnLPercent   float64   `json:"pnl_pct"`
	EntryTime    time.Time `json:"entry_time"`
	ExitTime     time.Time `json:"exit_time"`
	Duration     int64     `json:"duration_seconds"`
	StrategyName string    `json:"strategy"`
}

// GetTradeSummary computes aggregate performance metrics since the given time.
func (s *AnalyticsService) GetTradeSummary(since time.Time) (*TradeSummary, error) {
	var trades []models.DBTrade
	if err := s.db.Where("exit_time > ?", since).Find(&trades).Error; err != nil {
		return nil, err
	}

	summary := &TradeSummary{Since: since.Format(time.RFC3339)}
	bestTrade := math.Inf(-1)
	worstTrade := math.Inf(1)
	var grossWin, grossLoss, totalDuration float64

	for _, t := range trades {
		summary.TotalTrades++
		summary.TotalPnL += t.PnL
		totalDuration += float64(t.Duration)

		if t.PnL > 0 {
			summary.WinningTrades++
			grossWin += t.PnL
			summary.AvgWin += t.PnL
		} else {
			summary.LosingTrades++
			grossLoss += math.Abs(t.PnL)
			summary.AvgLoss += t.PnL
		}
		if t.PnL > bestTrade {
			bestTrade = t.PnL
		}
		if t.PnL < worstTrade {
			worstTrade = t.PnL
		}
	}

	if summary.TotalTrades > 0 {
		summary.WinRate = float64(summary.WinningTrades) / float64(summary.TotalTrades) * 100
		summary.AvgDuration = totalDuration / float64(summary.TotalTrades) / 3600
		summary.BestTrade = bestTrade
		summary.WorstTrade = worstTrade
	}
	if summary.WinningTrades > 0 {
		summary.AvgWin /= float64(summary.WinningTrades)
	}
	if summary.LosingTrades > 0 {
		summary.AvgLoss /= float64(summary.LosingTrades)
	}
	if grossLoss > 0 {
		summary.ProfitFactor = grossWin / grossLoss
	} else if grossWin > 0 {
		summary.ProfitFactor = 999 // no losers — use sentinel instead of Inf for JSON
	}

	// Compute total P&L % from account snapshots
	var firstSnap, lastSnap models.DBAccountSnapshot
	s.db.Where("snapshot_time >= ?", since).Order("snapshot_time ASC").First(&firstSnap)
	s.db.Order("snapshot_time DESC").First(&lastSnap)
	if firstSnap.PortfolioValue > 0 {
		summary.TotalPnLPct = (lastSnap.PortfolioValue - firstSnap.PortfolioValue) / firstSnap.PortfolioValue * 100
	}

	return summary, nil
}

// GetEquityCurve returns a time series of portfolio value from account snapshots.
func (s *AnalyticsService) GetEquityCurve(since time.Time) ([]EquityPoint, error) {
	var snaps []models.DBAccountSnapshot
	if err := s.db.Where("snapshot_time >= ?", since).Order("snapshot_time ASC").Find(&snaps).Error; err != nil {
		return nil, err
	}

	points := make([]EquityPoint, len(snaps))
	for i, snap := range snaps {
		points[i] = EquityPoint{Time: snap.SnapshotTime, Value: snap.PortfolioValue}
	}
	return points, nil
}

// GetSymbolBreakdown returns per-ticker performance since the given time.
func (s *AnalyticsService) GetSymbolBreakdown(since time.Time) ([]SymbolStat, error) {
	var trades []models.DBTrade
	if err := s.db.Where("exit_time > ?", since).Find(&trades).Error; err != nil {
		return nil, err
	}

	statsMap := make(map[string]*SymbolStat)
	winMap := make(map[string]int)

	for _, t := range trades {
		if _, ok := statsMap[t.Symbol]; !ok {
			statsMap[t.Symbol] = &SymbolStat{Symbol: t.Symbol}
		}
		st := statsMap[t.Symbol]
		st.Trades++
		st.TotalPnL += t.PnL
		if t.PnL > 0 {
			winMap[t.Symbol]++
		}
	}

	result := make([]SymbolStat, 0, len(statsMap))
	for sym, st := range statsMap {
		st.AvgPnL = st.TotalPnL / float64(st.Trades)
		st.WinRate = float64(winMap[sym]) / float64(st.Trades) * 100
		result = append(result, *st)
	}
	return result, nil
}

// GetDrawdownStats computes max and current drawdown from account snapshots.
func (s *AnalyticsService) GetDrawdownStats() (*DrawdownStats, error) {
	var snaps []models.DBAccountSnapshot
	if err := s.db.Order("snapshot_time ASC").Find(&snaps).Error; err != nil {
		return nil, err
	}

	stats := &DrawdownStats{}
	if len(snaps) == 0 {
		return stats, nil
	}

	peak := snaps[0].PortfolioValue
	t0 := snaps[0].SnapshotTime
	peakTime := &t0
	maxDD := 0.0

	for i := range snaps {
		v := snaps[i].PortfolioValue
		if v > peak {
			peak = v
			t := snaps[i].SnapshotTime
			peakTime = &t
		}
		if peak > 0 {
			dd := (peak - v) / peak * 100
			if dd > maxDD {
				maxDD = dd
			}
		}
	}

	current := snaps[len(snaps)-1].PortfolioValue
	currentDD := 0.0
	if peak > 0 {
		currentDD = (peak - current) / peak * 100
	}

	stats.MaxDrawdownPct = maxDD
	stats.CurrentDrawdownPct = currentDD
	stats.PeakValue = peak
	stats.CurrentValue = current
	stats.PeakTime = peakTime
	return stats, nil
}

// GetRecentTrades returns the last N closed trades, optionally filtered by symbol and start time.
func (s *AnalyticsService) GetRecentTrades(limit int, symbol string, since time.Time) ([]TradeDetail, error) {
	var trades []models.DBTrade
	q := s.db.Order("exit_time DESC")
	if !since.IsZero() {
		q = q.Where("exit_time > ?", since)
	}
	if symbol != "" {
		q = q.Where("symbol = ?", symbol)
	}
	if limit > 0 {
		q = q.Limit(limit)
	}
	if err := q.Find(&trades).Error; err != nil {
		return nil, err
	}

	result := make([]TradeDetail, len(trades))
	for i, t := range trades {
		result[i] = TradeDetail{
			ID:           t.ID,
			Symbol:       t.Symbol,
			Side:         t.Side,
			EntryPrice:   t.EntryPrice,
			ExitPrice:    t.ExitPrice,
			Qty:          t.Qty,
			PnL:          t.PnL,
			PnLPercent:   t.PnLPercent,
			EntryTime:    t.EntryTime,
			ExitTime:     t.ExitTime,
			Duration:     t.Duration,
			StrategyName: t.StrategyName,
		}
	}
	return result, nil
}

// GetStrategyBreakdown returns per-strategy performance since the given time.
func (s *AnalyticsService) GetStrategyBreakdown(since time.Time) ([]StrategyStat, error) {
	var trades []models.DBTrade
	if err := s.db.Where("exit_time > ?", since).Find(&trades).Error; err != nil {
		return nil, err
	}

	statsMap := make(map[string]*StrategyStat)
	winMap := make(map[string]int)

	for _, t := range trades {
		name := t.StrategyName
		if name == "" {
			name = "unclassified"
		}
		if _, ok := statsMap[name]; !ok {
			statsMap[name] = &StrategyStat{Strategy: name}
		}
		st := statsMap[name]
		st.Trades++
		st.TotalPnL += t.PnL
		if t.PnL > 0 {
			winMap[name]++
		}
	}

	result := make([]StrategyStat, 0, len(statsMap))
	for name, st := range statsMap {
		st.AvgPnL = st.TotalPnL / float64(st.Trades)
		st.WinRate = float64(winMap[name]) / float64(st.Trades) * 100
		result = append(result, *st)
	}
	return result, nil
}
