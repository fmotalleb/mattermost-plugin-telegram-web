package main

import (
	"database/sql"
	"fmt"
	"strings"
)

// The table name is intentionally very specific: it must never collide with Mattermost's own
// tables or with another plugin, and it is easy to recognise in the database.
const viewTrackingTable = "tg_webui_user_view_tracking"

func (p *Plugin) ensureViewTable() error {
	db, err := p.client.Store.GetMasterDB()
	if err != nil {
		return fmt.Errorf("could not open the database: %w", err)
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS tg_webui_user_view_tracking (
			user_id    VARCHAR(26) NOT NULL,
			post_id    VARCHAR(26) NOT NULL,
			channel_id VARCHAR(26) NOT NULL,
			viewed_at  BIGINT      NOT NULL,
			PRIMARY KEY (user_id, post_id)
		)`)
	if err != nil {
		return fmt.Errorf("could not create %s: %w", viewTrackingTable, err)
	}

	// Best effort: CREATE INDEX IF NOT EXISTS is Postgres-only, and a duplicate index on
	// MySQL is harmless to ignore.
	p.createIndex(db, `CREATE INDEX IF NOT EXISTS tg_webui_user_view_tracking_post ON tg_webui_user_view_tracking (post_id)`)
	p.createIndex(db, `CREATE INDEX IF NOT EXISTS tg_webui_user_view_tracking_channel ON tg_webui_user_view_tracking (channel_id, user_id)`)
	return nil
}

func (p *Plugin) createIndex(db *sql.DB, statement string) {
	if _, err := db.Exec(statement); err != nil && p.client.Store.DriverName() != "postgres" {
		// MySQL has no IF NOT EXISTS for indexes; retry without it once.
		alt := strings.Replace(statement, "IF NOT EXISTS ", "", 1)
		if _, altErr := db.Exec(alt); altErr != nil {
			p.API.LogDebug("could not create index", "statement", alt, "error", altErr.Error())
		}
	}
}

// recordView upserts a (user, post) view, keeping the most recent viewed_at. The update-then-insert
// shape keeps the SQL portable across Postgres and MySQL.
func (p *Plugin) recordView(userID, postID, channelID string, viewedAt int64) error {
	db, err := p.client.Store.GetMasterDB()
	if err != nil {
		return err
	}

	result, err := db.Exec(`
		UPDATE `+viewTrackingTable+`
		   SET viewed_at = GREATEST(viewed_at, `+p.ph(1)+`)
		 WHERE user_id = `+p.ph(2)+` AND post_id = `+p.ph(3),
		viewedAt, userID, postID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected > 0 {
		return err
	}

	_, err = db.Exec(`
		INSERT INTO `+viewTrackingTable+` (user_id, post_id, channel_id, viewed_at)
		VALUES (`+p.ph(1)+`, `+p.ph(2)+`, `+p.ph(3)+`, `+p.ph(4)+`)`,
		userID, postID, channelID, viewedAt)
	if err != nil && p.client.Store.DriverName() == "postgres" && strings.Contains(err.Error(), "duplicate key") {
		// Lost a race with the same (user, post): someone else inserted between UPDATE and INSERT.
		return nil
	}
	return err
}

func (p *Plugin) viewCounts(postIDs []string) (map[string]int, error) {
	db, err := p.client.Store.GetMasterDB()
	if err != nil {
		return nil, err
	}

	args := make([]any, len(postIDs))
	for i, id := range postIDs {
		args[i] = id
	}
	rows, err := db.Query(`
		SELECT post_id, COUNT(*)
		  FROM `+viewTrackingTable+`
		 WHERE post_id IN `+p.inPlaceholders(1, len(postIDs))+`
		 GROUP BY post_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := map[string]int{}
	for rows.Next() {
		var postID string
		var count int
		if err := rows.Scan(&postID, &count); err != nil {
			return nil, err
		}
		counts[postID] = count
	}
	return counts, rows.Err()
}

// viewUserIDs returns viewers newest first. Profile data remains behind Mattermost's normal
// user API, so this tracking table never becomes a second, stale user directory.
func (p *Plugin) viewUserIDs(postIDs []string) (map[string][]string, map[string]map[string]int64, error) {
	db, err := p.client.Store.GetMasterDB()
	if err != nil {
		return nil, nil, err
	}

	args := make([]any, len(postIDs))
	for i, id := range postIDs {
		args[i] = id
	}
	rows, err := db.Query(`
		SELECT post_id, user_id, viewed_at
		  FROM `+viewTrackingTable+`
		 WHERE post_id IN `+p.inPlaceholders(1, len(postIDs))+`
		 ORDER BY post_id, viewed_at DESC`, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	viewers := map[string][]string{}
	viewedAt := map[string]map[string]int64{}
	for rows.Next() {
		var postID, userID string
		var at int64
		if err := rows.Scan(&postID, &userID, &at); err != nil {
			return nil, nil, err
		}
		viewers[postID] = append(viewers[postID], userID)
		if viewedAt[postID] == nil {
			viewedAt[postID] = map[string]int64{}
		}
		viewedAt[postID][userID] = at
	}
	return viewers, viewedAt, rows.Err()
}

func (p *Plugin) seenPostIDs(userID string, postIDs []string) (map[string]bool, error) {
	db, err := p.client.Store.GetMasterDB()
	if err != nil {
		return nil, err
	}

	args := make([]any, len(postIDs)+1)
	args[0] = userID
	for i, id := range postIDs {
		args[i+1] = id
	}
	rows, err := db.Query(`
		SELECT post_id
		  FROM `+viewTrackingTable+`
		 WHERE user_id = `+p.ph(1)+`
		   AND post_id IN `+p.inPlaceholders(2, len(postIDs)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	seen := map[string]bool{}
	for rows.Next() {
		var postID string
		if err := rows.Scan(&postID); err != nil {
			return nil, err
		}
		seen[postID] = true
	}
	return seen, rows.Err()
}
